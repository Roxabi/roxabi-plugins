# Codebase design

## Steps
1. Inspect relevant existing modules and callers read-only. Describe each module's interface, invariants, ordering and failure modes, then locate actual seams and adapters.
2. Apply the deletion test: identify complexity that would move to callers if a module disappeared. Prefer a deep module with a small interface, locality and behavior observable through its interface. Identify compatibility constraints and concrete alternatives where trade-offs matter.
3. Ask the operator about unresolved design decisions at the current frontier and wait for genuine answers. Convert chosen interfaces and seams into invariants and observable criteria, not merely names in a plan.
4. Before decomposing Parent work, identify any behavior-neutral foundation needed to establish vocabulary or seams. Specify preserved behavior, responsibilities and compatibility evidence, and make dependent children natively blocked by that foundation. Account for its coverage explicitly.

## Done
Decisions, evidence references, interfaces, seams and invariants are retained; unresolved decisions remain questions. Any necessary foundation is a real behavior-neutral delivery obligation, not a scaffold. No repository changes or execution occurred during framing.
