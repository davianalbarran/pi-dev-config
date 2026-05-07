---
description: Scout scouts relevant files, planner drafts an implementation plan, worker implements, reviewer reviews, worker applies feedback
---
Use the subagent tool with the chain parameter to execute this workflow:

1. First, use the "scout" agent to find all code and docs relevant to the following prompt; if up to date documentation is necessary and there are no skills relevant to the prompt, use the bowser skill to search for relevant info: $@
2. Then, use the "planner" agent to create an implementation plan for "$@" using the context from the previous step (use {previous} placeholder)
3. Then, use the "worker" agent to implement the plan generated in the previous step (use {previous} placeholder)
4. Then, use the "reviewer" agent to review the implementation from the previous step (use {previous} placeholder)
5. Finally, use the "worker" agent to apply the feedback from the review (use {previous} placeholder)

Execute this as a chain, passing output between steps via {previous}.
