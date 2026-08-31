import { makePicker } from "./picker-record.mjs";
import { nextId } from "../util/ids.mjs";

const pickers = new Map();

export function registerPicker(name) {
  const picker = makePicker(nextId("picker"), name);
  pickers.set(picker.id, picker);
  return picker;
}

export function pickerName(pickerId) {
  return pickers.get(pickerId)?.name ?? "unknown";
}
