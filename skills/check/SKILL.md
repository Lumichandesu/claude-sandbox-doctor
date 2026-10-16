---
name: check
description: Check the sandbox.
disable-model-invocation: true
allowed-tools: Bash(node "${CLAUDE_PLUGIN_ROOT}/bin/claude-sandbox-doctor.mjs" *) Bash(node ${CLAUDE_PLUGIN_ROOT}/bin/claude-sandbox-doctor.mjs *) PowerShell(node "${CLAUDE_PLUGIN_ROOT}/bin/claude-sandbox-doctor.mjs" *) PowerShell(node ${CLAUDE_PLUGIN_ROOT}/bin/claude-sandbox-doctor.mjs *)
---

!`node "${CLAUDE_PLUGIN_ROOT}/bin/claude-sandbox-doctor.mjs" lint --project "${CLAUDE_PROJECT_DIR}" --markdown`

!`node "${CLAUDE_PLUGIN_ROOT}/bin/claude-sandbox-doctor.mjs" check --markdown`

At most 10 lines: whether the sandbox can work on this machine, and each setting that can never take effect with its file and the fix. If both are clean, say so in one line. Edit nothing until the user agrees.
