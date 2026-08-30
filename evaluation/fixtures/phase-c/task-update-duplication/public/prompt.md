# task-update-duplication

Each assignment command currently produces two assignment updates for one state transition.
Calling `assignTaskCommand(taskId, userId)` must persist the assignee and publish exactly one
observable assignment update. A later reassignment is a distinct transition and must add exactly
one more update, including the new user.

Remove the duplicate effect without suppressing valid later assignments. Preserve the command
API, task storage behavior, event payload shape, and unrelated task-completion behavior.
