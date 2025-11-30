import { AssessmentResult } from '../types';

// 豆包 API 配置
const DOUBAO_BASE_URL = 'https://ark.cn-beijing.volces.com/api/v3';
const DOUBAO_MODEL = 'doubao-seed-code-preview-251028';
const DOUBAO_EMBEDDING_MODEL = 'doubao-embedding-vision'; // 或使用 doubao-embedding-large
const API_KEY = process.env.API_KEY || process.env.DOUBAO_API_KEY;

// 检查 API Key
if (!API_KEY) {
  console.warn('警告: 未设置 DOUBAO_API_KEY 环境变量');
}

// Helper to convert blob to base64
export const blobToBase64 = (blob: Blob): Promise<string> => {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onloadend = () => {
      const base64String = reader.result as string;
      // Remove data url prefix (e.g. "data:image/jpeg;base64,")
      const base64Data = base64String.split(',')[1];
      resolve(base64Data);
    };
    reader.onerror = reject;
    reader.readAsDataURL(blob);
  });
};

/**
 * 调用豆包 Chat API 的通用函数
 */
async function callDoubaoChatAPI(messages: any[], options: {
  temperature?: number;
  responseFormat?: { type: string };
} = {}): Promise<string> {
  if (!API_KEY) {
    throw new Error('豆包 API Key 未设置，请在 .env.local 中设置 DOUBAO_API_KEY');
  }

  const response = await fetch(`${DOUBAO_BASE_URL}/chat/completions`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${API_KEY}`,
    },
    body: JSON.stringify({
      model: DOUBAO_MODEL,
      messages: messages,
      temperature: options.temperature ?? 0.2,
      ...(options.responseFormat && { response_format: options.responseFormat }),
    }),
  });

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(`豆包 API 调用失败: ${response.status} ${errorText}`);
  }

  const data = await response.json();
  const content = data.choices?.[0]?.message?.content;
  
  if (!content) {
    throw new Error('豆包 API 返回内容为空');
  }
  
  return content;
}

/**
 * 调用豆包 Embedding API
 */
async function callDoubaoEmbeddingAPI(text: string): Promise<number[]> {
  if (!API_KEY) {
    console.warn('API Key 未设置，无法获取 embedding');
    return [];
  }

  try {
    const response = await fetch(`${DOUBAO_BASE_URL}/embeddings`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${API_KEY}`,
      },
      body: JSON.stringify({
        model: DOUBAO_EMBEDDING_MODEL,
        input: text,
      }),
    });

    if (!response.ok) {
      const errorText = await response.text();
      throw new Error(`豆包 Embedding API 调用失败: ${response.status} ${errorText}`);
    }

    const data = await response.json();
    return data.data?.[0]?.embedding || [];
  } catch (error) {
    console.error('Embedding API 错误:', error);
    return [];
  }
}

/**
 * 1. Generates a visual description of the image using 豆包.
 * 2. Converts that description into a vector using embedding API.
 */
export async function generateImageIndex(base64: string, mimeType: string): Promise<{ description: string; embedding: number[] }> {
  try {
    // Step 1: Get Visual Description
    const messages = [
      {
        role: 'user',
        content: [
          {
            type: 'text',
            text: 'Detailed visual description of this image, strictly describing the subject, composition, artistic style, colors, and key elements. Do not analyze, just describe. Output plain text.'
          },
          {
            type: 'image_url',
            image_url: {
              url: `data:${mimeType};base64,${base64}`
            }
          }
        ]
      }
    ];

    const description = await callDoubaoChatAPI(messages) || 'Image content';

    // Step 2: Get Embedding
    const embedding = await callDoubaoEmbeddingAPI(description);

    return {
      description,
      embedding
    };
  } catch (error) {
    console.error("Indexing Error:", error);
    return { description: "", embedding: [] };
  }
}

/**
 * Calculates Cosine Similarity between two vectors.
 * Returns 0.0 to 1.0
 */
export function calculateCosineSimilarity(vecA: number[], vecB: number[]): number {
  if (vecA.length !== vecB.length || vecA.length === 0) return 0;
  
  let dotProduct = 0;
  let normA = 0;
  let normB = 0;
  
  for (let i = 0; i < vecA.length; i++) {
    dotProduct += vecA[i] * vecB[i];
    normA += vecA[i] * vecA[i];
    normB += vecB[i] * vecB[i];
  }
  
  if (normA === 0 || normB === 0) return 0;
  return dotProduct / (Math.sqrt(normA) * Math.sqrt(normB));
}

/**
 * Compares a target image against a reference image using 豆包.
 */
export async function analyzeImageRisk(
  targetImageBase64: string,
  targetMimeType: string,
  referenceImageBase64: string,
  referenceMimeType: string,
  referenceId: string,
  isPHashMatch: boolean = false
): Promise<AssessmentResult> {
  try {
    const prompt = `
角色：你是一位极其严苛的【AIGC版权法务鉴定专家】。
任务：对比【图片A（待测图）】与【图片B（企业原图）】，分析侵权风险。

前置校验：
系统底层像素哈希（pHash）匹配结果：${isPHashMatch ? "**【匹配】(距离<=5，极大概率为同一图或微改图)**" : "【未匹配】(无直接像素复制)"}

*** 评分标准（必须严格执行） ***

1. **若 pHash 为【匹配】**：
   - 这是物理层面的"实锤"。
   - 此时请忽略细微的压缩噪点或色差。
   - **Total Score 必须 >= 90分**。
   - Structure与Semantic必须满分。
   - 必须在 analysisText 中明确指出"检测到像素级复制或极高相似度"。

2. **若 pHash 为【未匹配】**，请进行深度视觉取证：
   - 只有当两者在"构图+主体+风格"三者高度统一时，才给高分（>60）。
   - 如果只是风格相似（如都是二次元）但内容不同，给低分（<30）。
   - 如果只是内容相似（如都有一只猫）但构图/画风完全不同，给中低分（30-50）。

*** 维度定义 (Total 100) ***
I.  核心语义 (Semantic, Max 40):
    - 画面叙事是否一致？核心物体/人物的特征是否雷同？
II. 视觉结构 (Structure, Max 40):
    - 骨架重合度：构图视角、物体位置关系、光影方向。
    - 风格渲染：笔触、配色方案、材质感。
III. 合规意图 (Compliance, Max 20):
    - 是否存在明显的"图生图(img2img)"痕迹？细节是否被挪用？

*** 输出要求 ***
请严格按照以下 JSON 格式输出，不要包含任何其他文字或 markdown 代码块标记：

{
  "scores": {
    "semantic": 0-40,
    "structure": 0-40,
    "compliance": 0-20,
    "total": 0-100
  },
  "evidence": {
    "similarities": ["具体相似点1", "具体相似点2", "具体相似点3"],
    "differences": ["具体差异点1", "具体差异点2"]
  },
  "analysisText": "专业的法务鉴定总结（中文），详细说明风险等级和依据",
  "breakdown": {
    "style": { "score": 0-40, "comment": "风格分析说明" },
    "composition": { "score": 0-40, "comment": "构图分析说明" },
    "elements": { "score": 0-40, "comment": "元素分析说明" },
    "font": { "score": 0-20, "comment": "字体分析说明" }
  },
  "modificationSuggestion": "修改建议或null"
}

Evidence 数组必须包含具体的视觉证据（例如："两张图中的人物姿势完全重叠"、"背景左上角都有一个红色的气球"）。
`;

    const messages = [
      {
        role: 'user',
        content: [
          {
            type: 'text',
            text: prompt
          },
          {
            type: 'image_url',
            image_url: {
              url: `data:${targetMimeType};base64,${targetImageBase64}`
            }
          },
          {
            type: 'image_url',
            image_url: {
              url: `data:${referenceMimeType};base64,${referenceImageBase64}`
            }
          }
        ]
      }
    ];

    const responseText = await callDoubaoChatAPI(messages, {
      temperature: 0.2,
      responseFormat: { type: 'json_object' }
    });

    // 解析 JSON 响应
    let result: any = {};
    try {
      // 尝试提取 JSON（可能包含 markdown 代码块或其他格式）
      let jsonText = responseText.trim();
      
      // 移除可能的 markdown 代码块标记（但保留 JSON 中的空格）
      jsonText = jsonText.replace(/^\s*/i, '').replace(/^```\s*/i, '').replace(/\s*```$/i, '').trim();
      
      // 尝试找到第一个 { 和最后一个 }
      const firstBrace = jsonText.indexOf('{');
      const lastBrace = jsonText.lastIndexOf('}');
      
      if (firstBrace !== -1 && lastBrace !== -1 && lastBrace > firstBrace) {
        jsonText = jsonText.substring(firstBrace, lastBrace + 1);
      }
      
      result = JSON.parse(jsonText);
    } catch (parseError) {
      console.error("JSON 解析失败:", parseError);
      console.error("原始响应:", responseText);
      // 如果解析失败，返回默认值
      result = {};
    }

    return {
      referenceImageId: referenceId,
      isMatch: (result.scores?.total || 0) > 0,
      scores: result.scores || { semantic: 0, structure: 0, compliance: 0, total: 0 },
      analysisText: result.analysisText || "分析完成",
      evidence: result.evidence || { similarities: [], differences: [] },
      breakdown: result.breakdown || {
        style: { score: 0, comment: "无" },
        composition: { score: 0, comment: "无" },
        elements: { score: 0, comment: "无" },
        font: { score: 0, comment: "无" }
      },
      modificationSuggestion: result.modificationSuggestion || null,
      pHashMatch: isPHashMatch
    };

  } catch (error) {
    console.error("豆包分析错误:", error);
    return {
      referenceImageId: referenceId,
      isMatch: false,
      scores: { semantic: 0, structure: 0, compliance: 0, total: 0 },
      analysisText: "分析服务发生错误，请重试。",
      evidence: { similarities: [], differences: [] },
      breakdown: {
        style: { score: 0, comment: "" },
        composition: { score: 0, comment: "" },
        elements: { score: 0, comment: "" },
        font: { score: 0, comment: "" }
      },
      modificationSuggestion: null,
      pHashMatch: isPHashMatch
    };
  }
}

/**
 * Generates a new image prompt based on the suggestion to avoid copyright
 */
export async function refinePrompt(originalSuggestion: string): Promise<string> {
  try {
    const messages = [
      {
        role: 'user',
        content: `基于以下版权规避建议，将其转化为一段高质量的 Stable Diffusion 或 Midjourney 提示词（英文 Prompt），并附带中文解释。
      
规避建议：${originalSuggestion}`
      }
    ];

    const responseText = await callDoubaoChatAPI(messages);
    return responseText || "";
  } catch (error) {
    console.error("提示词生成错误:", error);
    return "";
  }
}