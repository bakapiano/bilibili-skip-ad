import { INSTRUCTIONS } from "./legacy-v5.js";

export const VARIANT_NAME = "实验：连续广告区间 v1";
export const EXPECTED_BASELINE_HASH =
  "66c1984919801b1022b467593dd636815732eb826df95bd204d19ea47a8e8438";

const ORIGINAL_BOUNDARIES = `第三步：标注已确认广告的边界
- 起点为最早明确转入该商业推广的字幕。
- 终点为最后一句推广内容。
- “说回正题”等回归主线的过渡句及后续正文保留。
- 同一段连续推广合并为一个区间。
- 结果按时间排序，区间互不重叠。`;

export const REVISED_BOUNDARIES = `第三步：按连续内容标注已确认广告的边界
- 每个广告区间对应一段连续的商业推广，以该段实际讲述的内容为边界。
- 起点为该连续片段最早明确转入商业推广的字幕，终点为该片段最后一句推广内容。
- 当讲述恢复到视频正文的知识、评测、分析或叙事时，在恢复正文前结束当前广告区间，完整保留这段正文；之后再次进入商业推广时，另起一个广告区间。
- 即使前后属于同一品牌、同一产品或同一次合作，也按各自连续的推广片段分别输出。开头的品牌口号与后面的推广之间有正文时，分别划定各自边界。
- 根据字幕的实际语义识别正文恢复；“说回正题”等过渡句和后续正文一并保留，直接开始讲正文的情况也按相同规则处理。
- 输出前逐段检查起止编号之间的字幕：其中每个连续部分都应属于该段推广；发现独立正文段落时，在其前后拆分区间并保留正文。
- 结果按时间排序，区间互不重叠。`;

export function continuousAdBlocksPrompt(baseline = INSTRUCTIONS) {
  if (baseline.split(ORIGINAL_BOUNDARIES).length !== 2) {
    throw new Error("实验基线边界规则已变化，请核对后重新定义本轮实验。");
  }
  return baseline.replace(ORIGINAL_BOUNDARIES, REVISED_BOUNDARIES);
}
