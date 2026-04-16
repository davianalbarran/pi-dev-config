---
description: Deep research workflow using researcher subagent; prioritizes user-provided URLs and their sub-paths
---
Use the subagent tool in single mode with `agent: "researcher"`.

Delegate this task to the researcher subagent:

---
Perform deep research for this request:

$@

Instructions:
1. Treat user's prompt above as primary research objective.
2. If user included one or more URLs, navigate to those URLs first.
3. When useful, follow and inspect relevant sub-pages / sub-paths under those provided URLs.
4. Prioritize report findings based on information found on provided URLs and their relevant sub-paths before using broader web sources.
5. Use outside sources only to supplement, verify, or fill important gaps.
6. In final report, clearly distinguish:
   - findings from provided URLs / their sub-paths
   - findings from supplemental external sources
7. Produce thorough research report with:
   - executive summary
   - key findings
   - evidence / source list
   - open questions or uncertainties
   - recommended next steps

Return best possible deep-research report.
---

Execute this now by calling the `subagent` tool.
