pref("translationEnabled", true);
pref("mineruBaseURL", "https://mineru.net/api/v4");
pref("mineruApiToken", "");
pref("mineruModelVersion", "vlm");
pref("mineruLanguage", "en");
pref("mineruEnableTable", false);
pref("mineruEnableFormula", false);
pref("mineruEnableOCR", false);
pref("mineruPageRanges", "");
pref("mineruPollIntervalMs", 3000);
pref("mineruTimeoutSec", 300);
pref("translationProvider", "deepseek");
pref("translationBaseURL", "");
pref("translationApiKey", "");
pref("translationModel", "deepseek-chat");
pref("translationProfileName", "");
pref("translationProfiles", "[]");
pref("translationTargetLanguage", "简体中文");
pref(
  "translationSystemPrompt",
  "你是一名专业的计算机体系结构、集成电路与人工智能领域学术论文翻译助手。你的任务是将论文正文逐句、完整、准确地翻译为目标语言，并与原文内容一一对应。请严格遵守以下要求：1. 忠实翻译，不得遗漏、压缩、合并、改写或总结原文信息。2. 保留 Markdown 结构、标题层级、段落顺序、列表层级和引用编号。3. 公式、变量名、张量维度、符号、代码标识符、缩写、模型名、芯片名、数据集名、算法名和专业术语保持与原文一致；如无公认译法，保留原文。4. 数学公式必须输出为标准 LaTeX Markdown：行内公式一律用 $...$，独立公式一律用 $$ 单独成块包围；不要使用 \\(...\\)、\\[...\\]、代码块或 HTML 包装公式。5. 公式中的上下标必须使用 LaTeX 语法，例如 ${h}_{i}、${x}^{2}、$\\mathbf{W}_{q}$；不要把下标写成乘法、星号、空格或普通文本。6. 如果输入中的公式没有 $/$$ 定界符，或是 MinerU 输出的裸 LaTeX，也必须补上对应的 $...$ 或 $$...$$。7. 不要添加解释、注释、评价、扩写、前言、结语或任何额外内容。8. 对存在跨句上下文的技术描述，优先保持术语前后一致。9. 如果输入中出现不应翻译的占位内容、图表包装、算法伪代码或非正文片段，不要补写缺失内容，只翻译当前收到的正文。",
);
pref("translationTemperature", "0.1");
pref("translationChunkChars", 7000);
pref("translationConcurrency", 2);
pref("queueExtractConcurrency", 2);
pref("queueTranslateConcurrency", 1);
pref("skipImages", true);
pref("skipTables", true);
pref("skipAlgorithms", true);
pref("skipFrontMatter", true);
pref("skipReferences", true);
pref("noteHeading", "PDF 翻译");
pref("includeOriginalMarkdown", false);
