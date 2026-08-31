import { assignPickerCommand } from "../picking/assign-picker-command.mjs";
import { completePickCommand } from "../picking/complete-pick-command.mjs";
import { createPickList } from "../picking/pick-list-store.mjs";
import { registerPicker } from "../staff/picker-directory.mjs";
import { registerListeners } from "../events/register-listeners.mjs";
import { getPickerAssignments, getPickCompletions } from "../projections/floor-summary.mjs";

export function initFloor() {
  registerListeners();
}

export function runAssignmentScenario(zone, item, pickerName) {
  initFloor();
  const before = getPickerAssignments().length;
  const pickList = createPickList(zone, item);
  const picker = registerPicker(pickerName);
  assignPickerCommand(pickList.id, picker.id);
  return { pickList, picker, updates: getPickerAssignments().slice(before) };
}

export function runPickScenario(zone, item, pickerName) {
  initFloor();
  const before = getPickCompletions().length;
  const { pickList, picker } = runAssignmentScenario(zone, item, pickerName);
  completePickCommand(pickList.id);
  return { pickList, picker, updates: getPickCompletions().slice(before) };
}
