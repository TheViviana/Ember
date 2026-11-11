/** AI 的八种文章操作：入口在编辑器选区菜单，结果就地生成在选区旁边 */
export type AiActionId =
  | 'polish'
  | 'expand'
  | 'shorten'
  | 'summarize'
  | 'explain'
  | 'extend'
  | 'define'
  | 'research';

/**
 * 产物的落盘方式：
 * rewrite = 输出的是改写文本，可替换选区；
 * insert  = 输出的是针对片段的说明/摘要，只能插到选区之后，不能顶掉原文。
 */
export type AiApplyMode = 'rewrite' | 'insert';

export interface AiActionDefinition {
  readonly id: AiActionId;
  readonly label: string;
  readonly apply: AiApplyMode;
  readonly instruction: string;
}

/**
 * 所有指令都只作用于「选中文本」，并要求只输出结果本身：
 * 内联块直接展示模型原文，不需要前后缀、解释或 Markdown 包装。
 */
export const AI_ACTIONS: readonly AiActionDefinition[] = [
  {
    id: 'polish',
    label: '润色',
    apply: 'rewrite',
    instruction:
      '只润色「选中文本」：保持原意、事实与信息点不变，改善表达、节奏与用词；不要扩写、不要补充例子、不要解释。只输出润色后的文本。',
  },
  {
    id: 'expand',
    label: '扩写',
    apply: 'rewrite',
    instruction:
      '扩写「选中文本」：在不改变原意与事实的前提下，补足隐含的前提、因果链与具体例子，使论证完整；不得重复原句、不得空泛抒情，目标长度约为原文 2 到 3 倍。只输出扩写后的文本。',
  },
  {
    id: 'shorten',
    label: '缩写',
    apply: 'rewrite',
    instruction:
      '缩写「选中文本」：保留关键事实、结论与限定条件，删去修饰语、重复表述与举例，压缩到原文约一半；不得引入原文没有的信息。只输出缩写后的文本。',
  },
  {
    id: 'summarize',
    label: '总结',
    apply: 'insert',
    instruction:
      '针对「选中文本」写一份摘要：用三到五条要点概括，不加入原文没有的信息，不与原文重复举例。只输出摘要。',
  },
  {
    id: 'explain',
    label: '解释',
    apply: 'insert',
    instruction:
      '针对「选中文本」写一段解释：说明其中的概念、因果关系与推理步骤，面向没读过上下文的人；不要复述原文，不要评价。只输出解释。',
  },
  {
    id: 'extend',
    label: '延伸',
    apply: 'insert',
    instruction:
      '针对「选中文本」补充延伸内容：给出原文未展开的反例、相邻主题或可继续追问的问题；不要复述原文。只输出延伸内容。',
  },
  {
    id: 'define',
    label: '定义',
    apply: 'insert',
    instruction:
      '针对「选中文本」整理术语定义：逐个给出定义，优先沿用原文表述；没有术语就说明「没有可定义的术语」。只输出定义列表。',
  },
  {
    id: 'research',
    label: '研究',
    apply: 'insert',
    instruction:
      '针对「选中文本」做研究性梳理：归纳主题、比较观点、指出证据缺口；不引用任何外部网页，不编造来源。只输出梳理结果。',
  },
];

export const findAiAction = (id: AiActionId): AiActionDefinition | undefined =>
  AI_ACTIONS.find((action) => action.id === id);
