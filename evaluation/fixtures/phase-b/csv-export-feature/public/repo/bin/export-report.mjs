import { writeReport } from "../src/report-writer.mjs";

const report = {
  columns: ["name", "score"],
  rows: [
    ["Alice", 95],
    ["Bob", 88],
  ],
};

const format = process.argv[2] ?? "json";
console.log(writeReport(report, format));
