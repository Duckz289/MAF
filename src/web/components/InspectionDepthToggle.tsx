import { Tab, TabList } from "@fluentui/react-components";
import type { InspectionDepth } from "../../domain/control-center";

export function InspectionDepthToggle({
  value,
  onChange,
}: {
  value: InspectionDepth;
  onChange: (depth: InspectionDepth) => void;
}) {
  return (
    <TabList
      selectedValue={value}
      onTabSelect={(_event, data) => onChange(String(data.value) as InspectionDepth)}
    >
      <Tab value="SIMPLE">Simple</Tab>
      <Tab value="ADVANCED">Advanced</Tab>
      <Tab value="INSPECT">Inspect</Tab>
    </TabList>
  );
}
