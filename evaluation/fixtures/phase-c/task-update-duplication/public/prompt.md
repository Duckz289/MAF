# task-update-duplication

One assignment command produces two assignment updates. Run `node bin/demo.mjs`: assigning a single
picker to a single pick list records two updates on the floor summary, while completing a pick
records one.

`assignPickerCommand(pickListId, pickerId)` must persist the assignee and publish exactly one
observable `PICKER_ASSIGNED` update for that transition. Reassigning the same pick list to a
different picker is a distinct transition and must add exactly one more update, naming the new
picker. Independent pick lists must each produce one update per assignment.

Remove the duplicate effect without suppressing valid later assignments. Preserve the command API,
the pick-list storage behaviour, the event payload shape (`pickListId` and `pickerId`), and the
unrelated pick-completion, stock and shift-report behaviour.
