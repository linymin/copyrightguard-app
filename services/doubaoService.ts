import { Doubao } from '@doubaoai/sdk';
import { AssessmentResult } from '../types';

// 初始化豆包客户端
const doubao = new Doubao({ apiKey: process.env.DOUBAO_API_KEY });

export const blobToBase64 = (blob: Blob): Promise<string> => {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onloadend = () => {
      const base64String = reader.result as string;
      const base64Data = base64String.split(',')[1];
      resolve(base64Data);
    };
    reader.onerror = reject;
    reader.readAsDataURL(blob);
  });
};

async function retryWithBackoff<T>(
  operation: () => Promise<T>,
  retries = 5,
  delay = 2000
): Promise<T> {
  try {
    return await operation();
  } catch (error: any) {
    const isRateLimit = error.status === 429 || 
      (error.message && error.message.includes('rate limit'));

    if (retries > 0 && isRateLimit) {
      console.warn(`Rate limit hit. Retrying in ${delay}ms...`);
      await new Promise(resolve => setTimeout(resolve, delay));
      return retryWithBackoff(operation, retries - 1, delay * 2);
    }
    throw error;
  }
}

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
      角色：你是一位极其严苛的【AIGC版权权法务鉴定专家】。
      任务：对比【图片A（待测图）】与【图片B（企业原图）】，分析侵权风险。

      前置校验：
      系统底层像素哈希（pHash）匹配结果：${isPHashMatch ? "**【匹配】(距离<=5，极大概率为同一图或微改图)**" : "【未匹配】(无直接像素复制)"}

      *** 评分标准（必须严格执行） ***
      
      1. **若 pHash 为【匹配】**：
         - 这是物理层面的“实锤”。
         - 此时请忽略细微的压缩噪点或色差。
         - **Total Score 必须 >= 90分**。
         - Structure与Semantic必须满分。
         - 必须在 analysisText 中明确指出“检测到像素级复制或极高相似度”。

      2. **若 pHash 为【未匹配】**，请进行深度视觉取证：
         - 只有当两者在“构图+主体+风格”三者高度统一时，才给高分（>60）。
         - 如果只是风格相似（如都是二次元）但内容不同，给低分（<30）。
         - 如果只是内容相似（如都有一只猫）但构图/画风完全不同，给中低分（30-50）。

      *** 维度定义 (Total 100) ***
      I.  核心语义 (Semantic, Max 40):
          - 画面叙事是否一致？核心物体/人物的特征是否雷同？
      II. 视觉结构 (Structure, Max 40):
          - 骨架重合度：构图视角、物体位置关系、光影方向。
          - 风格渲染：笔触、配色方案、材质感。
      III. 合规意图 (Compliance, Max 20):
          - 是否存在明显的“图生图(img2img)”痕迹？细节是否被挪用？

      请输出JSON格式的分析报告，包含以下字段：
      - scores: {semantic: number, structure: number, compliance: number, total: number}
      - evidence: {similarities: string[], differences: string[]}
      - analysisText: string
      - breakdown: {style: {score: number, comment: string}, composition: {...}, elements: {...}, font: {...}}
      - modificationSuggestion: string|null
    `;

    const response = await retryWithBackoff(async () => {
      return await doubao.chat.completions.create({
        model: "doubao-seed-1-6-vision-250815", // 豆包最新多模态模型
        messages: [
          {
            role: "user",
            content: [
              { type: "text", text: prompt },
              { 
                type: "image_url", 
                image_url: { url: `data:${targetMimeType};base64,${targetImageBase64}` } 
              },
              { 
                type: "image_url", 
                image_url: { url: `data:${referenceMimeType};base64,${referenceImageBase64}` } 
              }
            ]
          }
        ],
        temperature: 0.2
      });
    });

    const resultText = response.choices[0].message.content;
    if (!resultText) throw new Error("未获取到有效响应");
    const result = JSON.parse(resultText);

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
      modificationSuggestion: result.modificationSuggestion,
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

export async function refinePrompt(originalSuggestion: string): Promise<string> {
  const prompt = `
    任务：基于AI给出的【版权规避建议】，请为用户提供具体的【提示词修改策略】。
    
    要求：
    1. 语言：必须使用中文。
    2. 核心目标：指导用户如何修改生成式AI的提示词来规避版权风险。
    3. 内容：列出需要替换、删除或新增的关键描述词。
    4. 格式：清晰的建议列表。

    版权规避建议原文：${originalSuggestion}
  `;

  const response = await retryWithBackoff(async () => {
    return await doubao.chat.completions.create({
      model: "doubao-seed-1-6-vision-250815",
      messages: [{ role: "user", content: prompt }],
      temperature: 0.3
    });
  });
  
  return response.choices[0].message.content || "无法生成建议，请参考原始分析报告。";
}