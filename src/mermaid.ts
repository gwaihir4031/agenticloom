import {
  PipelineSpec,
  FlowItem,
  isStep,
  isReviewLoop,
  isHumanGate,
  isParallel,
  isBranch,
  isAggregate,
  isForeach,
  agentLabel,
} from './types.js';

/** Per-emit fresh-id factory. Returns `n1`, `n2`, ... — always a valid
 *  Mermaid node identifier regardless of the names in the source YAML. */
function makeFresh(): () => string {
  let i = 0;
  return () => `n${++i}`;
}

/** HTML-entity-escape a free-form string so it's safe inside a Mermaid
 *  quoted label (`["..."]`, `{{"..."}}`, etc.). Mermaid renders these
 *  entities back to their characters in the diagram. Order matters: `&`
 *  must be escaped first so the substitutions for other chars don't
 *  double-escape their own `&`s. */
function escapeLabel(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/** Result of walking a single FlowItem (or a sequence). `heads` are the
 *  node IDs an external predecessor should connect INTO; `tails` are the
 *  node IDs an external successor connects FROM. For most primitives both
 *  are the single emitted node. For `branch`, tails is the union of arm
 *  tails. For `parallel`, both heads and tails are the union of children's. */
interface Walked {
  heads: string[];
  tails: string[];
}

/** Connect every (tail, head) pair via a structural `-->` arrow. Skipped
 *  cleanly when either side is empty (e.g., empty flow, no pipeline inputs). */
function connectAll(fromTails: string[], toHeads: string[], lines: string[], indent: string): void {
  for (const t of fromTails) {
    for (const h of toHeads) {
      lines.push(`${indent}${t} --> ${h}`);
    }
  }
}

/** Emit one FlowItem's nodes + internal edges, return its Walked endpoints.
 *  One branch per FlowItem variant; the schema's set of variants is closed,
 *  so the trailing throw is a defensive assert against a primitive being
 *  added to the schema without a matching emit branch here.
 *
 *  `bindNodes` is threaded mutably so a step's `on_fail.retry_from` can
 *  resolve to the target primitive's node ID emitted earlier in the walk.
 *  Compile.ts rejects unresolved `retry_from`s, so an unresolved lookup
 *  here only fires when the caller skipped compile validation (e.g.
 *  `--mermaid-only`). In that case the step's emit renders a visibly
 *  "broken" sink node + back-edge naming the unresolved bind, so the user
 *  notices the typo rather than mistaking it for "I forgot to write
 *  on_fail." */
function walkItem(
  item: FlowItem,
  lines: string[],
  fresh: () => string,
  indent: string,
  bindNodes: Map<string, string>,
): Walked {
  if (isStep(item)) {
    const id = fresh();
    // Label the node by the resolved agent reference: a persona name is itself;
    // an inline agent is its required `name`. The node id (`fresh()`) stays the
    // Mermaid identifier; this is only the visible label.
    lines.push(`${indent}${id}(["${escapeLabel(agentLabel(item.step))}"])`);
    if (item.bind !== undefined) bindNodes.set(item.bind, id);
    if (item.on_fail !== undefined) {
      const target = bindNodes.get(item.on_fail.retry_from);
      const maxRetries = item.on_fail.max_retries ?? 1;
      if (target !== undefined) {
        lines.push(`${indent}${id} -.->|retry × ${maxRetries}| ${target}`);
      } else {
        // Unresolved retry_from. the compile module would have rejected this; if we
        // got here, --mermaid-only bypassed compile validation. Render a
        // visible "broken" edge so the user notices the typo rather than
        // assuming on_fail was forgotten.
        const sinkId = `unresolved_${id}_${item.on_fail.retry_from}`;
        lines.push(`${indent}${sinkId}{{"⚠ unresolved: $${item.on_fail.retry_from}"}}`);
        lines.push(`${indent}${id} -.->|retry × ${maxRetries}| ${sinkId}`);
      }
    }
    return { heads: [id], tails: [id] };
  }

  if (isReviewLoop(item)) {
    const r = item.review_loop;
    const loopId = fresh();
    const maxIters = r.max_iters ?? 3;
    const title =
      r.approve_when !== undefined
        ? `review_loop (max_iters: ${maxIters}, approve_when: ${escapeLabel(r.approve_when)})`
        : `review_loop (max_iters: ${maxIters})`;
    lines.push(`${indent}subgraph ${loopId}["${title}"]`);
    const inner = indent + '    ';
    const writerId = fresh();
    lines.push(`${inner}${writerId}(["${escapeLabel(agentLabel(r.writer))}"])`);

    if (!Array.isArray(r.reviewer)) {
      // Single-reviewer form (persona name or inline agent). Emit reviewer node,
      // forward + back edges.
      const reviewerId = fresh();
      lines.push(`${inner}${reviewerId}(["${escapeLabel(agentLabel(r.reviewer))}"])`);
      lines.push(`${inner}${writerId} -->|"writer_produces"| ${reviewerId}`);
      lines.push(`${inner}${reviewerId} -.->|"on fail"| ${writerId}`);
    } else {
      // Compound form (subflow array). Walk the reviewer subflow inside the
      // subgraph; the last item's tails feed the loop's on-fail back-edge to the
      // writer. The schema (validateReviewerSubflow in compile/validation.ts)
      // guarantees the last item is an aggregate, but mermaid doesn't enforce
      // that — whatever tails the subflow exposes back-edge to the writer.
      const subflow = emitSequence(r.reviewer, lines, fresh, inner, bindNodes);
      // Writer feeds the subflow's first item(s); use writer_produces label
      // for the first hop (matches the single-form semantics — writer's
      // output is the artifact reviewers read).
      for (const h of subflow.heads) {
        lines.push(`${inner}${writerId} -->|"writer_produces"| ${h}`);
      }
      for (const t of subflow.tails) {
        lines.push(`${inner}${t} -.->|"on fail"| ${writerId}`);
      }
    }

    lines.push(`${indent}end`);
    // Heads and tails of the whole review_loop are the writer — external
    // predecessors connect INTO the writer (it consumes the loop's input);
    // external successors connect FROM the writer (the loop's bind is the
    // writer's final draft path). Record the loop's bind against the
    // writer — that's the node a retry-from would re-enter.
    if (r.bind !== undefined) bindNodes.set(r.bind, writerId);
    return { heads: [writerId], tails: [writerId] };
  }

  if (isAggregate(item)) {
    const a = item.aggregate;
    const id = fresh();
    const keys = Object.keys(a.inputs).map(escapeLabel).join(', ');
    lines.push(`${indent}${id}[/"aggregate: ${keys}"\\]`);
    if (a.bind !== undefined) bindNodes.set(a.bind, id);
    return { heads: [id], tails: [id] };
  }

  if (isHumanGate(item)) {
    const h = item.human_gate;
    const id = fresh();
    // A persona gate labels with its agent name; a general gate (interactive
    // with `agent:` omitted) has no persona, so it falls back to the
    // 'human-gate' label.
    const label =
      h.interactive === true
        ? `human_gate (interactive): ${escapeLabel(h.agent ?? 'human-gate')}`
        : `human_gate (y/N)`;
    lines.push(`${indent}${id}{{"${label}"}}`);
    return { heads: [id], tails: [id] };
  }

  if (isParallel(item)) {
    const children = item.parallel;
    // When `bind:` is set, use the bind name as the subgraph identifier so
    // Mermaid renders the bind as the visible subgraph label. Without bind,
    // mint a fresh `n*` id and use "parallel" as the label.
    const parId = item.bind !== undefined ? item.bind : fresh();
    const header =
      item.bind !== undefined
        ? `${indent}subgraph ${item.bind}`
        : `${indent}subgraph ${parId}["parallel"]`;
    lines.push(header);
    const inner = indent + '    ';
    const childHeads: string[] = [];
    const childTails: string[] = [];
    for (const child of children) {
      // Each child walks as its own sequence-of-one; we collect its heads
      // (for predecessor fan-out) and tails (for successor fan-in). The
      // children are siblings — no edges BETWEEN them.
      const w = walkItem(child, lines, fresh, inner, bindNodes);
      childHeads.push(...w.heads);
      childTails.push(...w.tails);
    }
    lines.push(`${indent}end`);
    if (item.bind !== undefined) bindNodes.set(item.bind, parId);
    return { heads: childHeads, tails: childTails };
  }

  if (isBranch(item)) {
    const b = item.branch;
    const diamondId = fresh();
    lines.push(`${indent}${diamondId}{"when: ${escapeLabel(b.when)}"}`);
    const tails: string[] = [];

    // When the branch has a `bind:`, wrap the whole then(/else) emission in
    // an outer labeled subgraph so the bind shows up in the diagram. The
    // diamond stays outside the subgraph because predecessors connect to
    // the decision, not the wrapped body.
    if (b.bind !== undefined) {
      lines.push(`${indent}subgraph ${b.bind}`);
    }
    const armIndent = b.bind !== undefined ? indent + '    ' : indent;
    const armInner = armIndent + '    ';

    const thenId = fresh();
    lines.push(`${armIndent}subgraph ${thenId}["then"]`);
    const thenWalked = emitSequence(b.then, lines, fresh, armInner, bindNodes);
    lines.push(`${armIndent}end`);
    for (const h of thenWalked.heads) {
      lines.push(`${armIndent}${diamondId} -->|"true"| ${h}`);
    }
    tails.push(...thenWalked.tails);

    if (b.else !== undefined) {
      const elseId = fresh();
      lines.push(`${armIndent}subgraph ${elseId}["else"]`);
      const elseWalked = emitSequence(b.else, lines, fresh, armInner, bindNodes);
      lines.push(`${armIndent}end`);
      for (const h of elseWalked.heads) {
        lines.push(`${armIndent}${diamondId} -->|"false"| ${h}`);
      }
      tails.push(...elseWalked.tails);
    }

    if (b.bind !== undefined) {
      lines.push(`${indent}end`);
      bindNodes.set(b.bind, diamondId);
    }

    // Heads = the diamond (predecessor connects INTO the decision).
    // Tails = union of arms' tails (successor connects FROM whichever arm ran).
    return { heads: [diamondId], tails };
  }

  if (isForeach(item)) {
    const f = item.foreach;
    // When `bind:` is set, use the bind name as the subgraph identifier so
    // Mermaid renders the bind as the subgraph label prefix. Without bind,
    // mint a fresh `n*` id and use only the "foreach over <expr>" label.
    // Same convention parallel + branch use for bind-as-subgraph-ID.
    const feId = f.bind !== undefined ? f.bind : fresh();
    const overLabel = escapeLabel(f.over);
    const asLabel = escapeLabel(f.as);
    const label =
      f.bind !== undefined
        ? `foreach: ${f.bind} over ${overLabel} (as ${asLabel})`
        : `foreach over ${overLabel} (as ${asLabel})`;
    const header =
      f.bind !== undefined
        ? `${indent}subgraph ${f.bind}["${label}"]`
        : `${indent}subgraph ${feId}["${label}"]`;
    lines.push(header);
    const inner = indent + '    ';
    const bodyWalked = emitSequence(f.body, lines, fresh, inner, bindNodes);
    lines.push(`${indent}end`);
    // Record bind → subgraph id so a downstream step's `retry_from:` can
    // resolve a back-edge into the foreach (same pattern parallel uses).
    if (f.bind !== undefined) bindNodes.set(f.bind, feId);
    // Heads = body's first-item heads (predecessor connects into the first
    // body item). Tails = body's last-item tails (successor connects out
    // from the last body item). Per-iteration semantics are communicated
    // by the subgraph label, not by extra structural edges.
    return { heads: bodyWalked.heads, tails: bodyWalked.tails };
  }

  // Unrecognized shape is a programming error — a FlowItem variant was added
  // to the schema without a matching emit branch above. After exhaustive
  // narrowing above, `item` is typed `never` here, so cast back to `object`
  // for the diagnostic Object.keys read. Loud-fail rather than emitting an
  // empty stanza that silently drops the node.
  throw new Error(
    `emitMermaid: unsupported FlowItem shape: ${Object.keys(item as object).join(', ')}`,
  );
}

/** Walk a sequence of FlowItems, emitting each and connecting `prev.tails`
 *  to `curr.heads` between every adjacent pair. Returns the sequence's
 *  overall heads (= first item's heads) and tails (= last item's tails) so
 *  the caller can connect into / out of the whole sequence. */
function emitSequence(
  items: FlowItem[],
  lines: string[],
  fresh: () => string,
  indent: string,
  bindNodes: Map<string, string>,
): Walked {
  if (items.length === 0) return { heads: [], tails: [] };
  const first = walkItem(items[0], lines, fresh, indent, bindNodes);
  let prev = first;
  for (let i = 1; i < items.length; i++) {
    const curr = walkItem(items[i], lines, fresh, indent, bindNodes);
    connectAll(prev.tails, curr.heads, lines, indent);
    prev = curr;
  }
  return { heads: first.heads, tails: prev.tails };
}

/** Render a parsed Pipeline spec as a Mermaid `flowchart TD` diagram.
 *  View-only artifact emitted by `loom compile` alongside the `.ts` output.
 *  No validation beyond the zod parse the spec already passed — agent-file
 *  existence and bind-scope checks live in `compile/` and run separately. */
export function emitMermaid(spec: PipelineSpec): string {
  const lines: string[] = ['flowchart TD'];
  const fresh = makeFresh();
  const indent = '    ';

  const inputHeads: string[] = [];
  for (const name of spec.inputs) {
    const id = fresh();
    lines.push(`${indent}${id}[/"${escapeLabel(name)}"/]`);
    inputHeads.push(id);
  }

  // bind → emitted-node-id, populated as each bind-bearing primitive is
  // walked, consumed when a downstream step's `on_fail.retry_from` resolves
  // to a back-edge target. Empty when no pipeline uses on_fail.
  const bindNodes = new Map<string, string>();
  const flow = emitSequence(spec.flow, lines, fresh, indent, bindNodes);
  connectAll(inputHeads, flow.heads, lines, indent);

  return lines.join('\n') + '\n';
}
