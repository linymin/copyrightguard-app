import React, { useState, useRef, useEffect } from 'react';
import { Upload, ShieldCheck, Image as ImageIcon, AlertTriangle, CheckCircle, RefreshCw, ChevronRight, FileWarning, BarChart3, Wand2, Fingerprint, Search } from 'lucide-react';
import { AppState, UploadedImage, AssessmentResult, AnalysisStatus } from './types';
import { analyzeImageRisk, blobToBase64, refinePrompt } from './services/geminiService';
import { calculateImageHash, calculateHammingDistance } from './services/imageUtils';
import RiskChart from './components/RiskChart';

// Initial Mock Data for Gallery
const INITIAL_GALLERY: UploadedImage[] = [
  { id: 'ref1', url: 'https://picsum.photos/id/237/400/400', name: '品牌吉祥物-黑狗.jpg', uploadedAt: Date.now() },
  { id: 'ref2', url: 'https://picsum.photos/id/1015/400/400', name: '年度风景海报.jpg', uploadedAt: Date.now() },
  { id: 'ref3', url: 'https://picsum.photos/id/1060/400/400', name: '咖啡师宣传图.jpg', uploadedAt: Date.now() },
  { id: 'ref4', url: 'https://picsum.photos/id/870/400/400', name: '灯塔背景素材.jpg', uploadedAt: Date.now() },
];

const App: React.FC = () => {
  const [appState, setAppState] = useState<AppState>(AppState.GALLERY);
  const [gallery, setGallery] = useState<UploadedImage[]>(INITIAL_GALLERY);
  
  // Assessment State
  const [targetImage, setTargetImage] = useState<UploadedImage | null>(null);
  const [results, setResults] = useState<AssessmentResult[]>([]);
  const [status, setStatus] = useState<AnalysisStatus>({ step: 'idle', progress: 0 });
  const [selectedResult, setSelectedResult] = useState<AssessmentResult | null>(null);
  const [refinedPrompt, setRefinedPrompt] = useState<string | null>(null);
  const [isGeneratingPrompt, setIsGeneratingPrompt] = useState(false);

  // References
  const fileInputRef = useRef<HTMLInputElement>(null);
  const galleryInputRef = useRef<HTMLInputElement>(null);

  // Initialize gallery hashes if missing
  useEffect(() => {
    const enrichGallery = async () => {
      let changed = false;
      const enriched = await Promise.all(gallery.map(async (img) => {
        if (!img.hash) {
          try {
            const hash = await calculateImageHash(img.url);
            changed = true;
            return { ...img, hash };
          } catch (e) {
            console.warn("Failed to hash gallery image", img.id, e);
            return img;
          }
        }
        return img;
      }));
      if (changed) setGallery(enriched);
    };
    enrichGallery();
  }, [gallery.length]);

  // --- Handlers ---

  const handleGalleryUpload = async (e: React.ChangeEvent<HTMLInputElement>) => {
    if (e.target.files && e.target.files.length > 0) {
      const newImages: UploadedImage[] = [];
      for (let i = 0; i < e.target.files.length; i++) {
        const file = e.target.files[i];
        const base64 = await blobToBase64(file);
        const url = `data:${file.type};base64,${base64}`;
        let hash = undefined;
        try {
           hash = await calculateImageHash(url);
        } catch (e) {
           console.error("Hash calculation failed", e);
        }

        newImages.push({
          id: `new_${Date.now()}_${i}`,
          url,
          name: file.name,
          uploadedAt: Date.now(),
          hash
        });
      }
      setGallery([...gallery, ...newImages]);
    }
  };

  const handleTargetUpload = async (e: React.ChangeEvent<HTMLInputElement>) => {
    if (e.target.files && e.target.files[0]) {
      const file = e.target.files[0];
      const base64 = await blobToBase64(file);
      const url = `data:${file.type};base64,${base64}`;
      
      let hash = undefined;
      try {
        hash = await calculateImageHash(url);
      } catch (e) {
        console.error("Target hash calculation failed", e);
      }

      setTargetImage({
        id: `target_${Date.now()}`,
        url,
        name: file.name,
        uploadedAt: Date.now(),
        hash
      });
      // Reset
      setResults([]);
      setSelectedResult(null);
      setRefinedPrompt(null);
      setStatus({ step: 'idle', progress: 0 });
    }
  };

  const getMimeTypeFromUrl = (url: string) => {
    const match = url.match(/^data:(.*?);base64,/);
    return match ? match[1] : 'image/jpeg';
  };

  const startAssessment = async () => {
    if (!targetImage || gallery.length === 0) return;

    setStatus({ step: 'analyzing', progress: 0 });
    
    const targetMime = getMimeTypeFromUrl(targetImage.url);
    const targetBase64 = targetImage.url.split(',')[1];
    
    // Process in batches of 3 to avoid rate limits but improve speed
    const BATCH_SIZE = 3;
    const allResults: AssessmentResult[] = [];
    const totalRefs = gallery.length;

    for (let i = 0; i < totalRefs; i += BATCH_SIZE) {
      const batch = gallery.slice(i, i + BATCH_SIZE);
      
      const batchPromises = batch.map(async (refImg) => {
        // 1. pHash Check
        let isPHashMatch = false;
        let hashDist = -1;
        
        if (targetImage.hash && refImg.hash) {
          hashDist = calculateHammingDistance(targetImage.hash, refImg.hash);
          if (hashDist >= 0 && hashDist <= 8) { // Slightly looser threshold for "suspicious"
            isPHashMatch = true;
          }
        }

        let refBase64 = '';
        let refMime = 'image/jpeg';

        if (refImg.url.startsWith('data:')) {
            refMime = getMimeTypeFromUrl(refImg.url);
            refBase64 = refImg.url.split(',')[1];
        } else {
            try {
               const response = await fetch(refImg.url);
               const blob = await response.blob();
               refMime = blob.type;
               refBase64 = await blobToBase64(blob);
            } catch (e) {
               console.warn("Could not fetch remote reference image", refImg.name);
               return null;
            }
        }

        // 2. Gemini Analysis
        return analyzeImageRisk(
          targetBase64, 
          targetMime, 
          refBase64, 
          refMime, 
          refImg.id, 
          isPHashMatch
        );
      });

      setStatus({ 
        step: 'analyzing', 
        progress: Math.floor(((i + 1) / totalRefs) * 100),
        currentFile: `正在扫描第 ${i+1}-${Math.min(i+BATCH_SIZE, totalRefs)} 张...`
      });

      const batchResults = await Promise.all(batchPromises);
      batchResults.forEach(r => {
        if (r && r.scores.total > 0) allResults.push(r);
      });
    }

    setStatus({ step: 'complete', progress: 100 });
    
    // Sort logic: pHash matches first, then by total score
    allResults.sort((a, b) => {
      if (a.pHashMatch && !b.pHashMatch) return -1;
      if (!a.pHashMatch && b.pHashMatch) return 1;
      return b.scores.total - a.scores.total;
    });
    
    setResults(allResults);
    if (allResults.length > 0) {
      setSelectedResult(allResults[0]);
    }
  };

  const handleGeneratePrompt = async () => {
    if (!selectedResult || !selectedResult.modificationSuggestion) return;
    setIsGeneratingPrompt(true);
    try {
      const prompt = await refinePrompt(selectedResult.modificationSuggestion);
      setRefinedPrompt(prompt);
    } catch (e) {
      console.error(e);
    } finally {
      setIsGeneratingPrompt(false);
    }
  };

  // --- Render Helpers ---

  const renderGallery = () => (
    <div className="p-6">
      <div className="flex justify-between items-center mb-6">
        <div>
          <h2 className="text-2xl font-bold text-slate-800">企业核心资产库</h2>
          <p className="text-slate-500 text-sm mt-1">
            已建立索引 {gallery.length} 张受保护图片。系统将自动进行像素级查重和 AI 语义比对。
          </p>
        </div>
        <button 
          onClick={() => galleryInputRef.current?.click()}
          className="flex items-center gap-2 bg-slate-900 hover:bg-slate-800 text-white px-4 py-2 rounded-lg transition-colors"
        >
          <Upload size={18} />
          <span>批量入库</span>
        </button>
        <input 
          type="file" 
          multiple 
          ref={galleryInputRef} 
          className="hidden" 
          accept="image/*" 
          onChange={handleGalleryUpload} 
        />
      </div>

      <div className="grid grid-cols-2 md:grid-cols-4 lg:grid-cols-5 gap-4">
        {gallery.map((img) => (
          <div key={img.id} className="group relative aspect-square bg-white rounded-xl overflow-hidden border border-slate-200 shadow-sm hover:shadow-md transition-shadow">
            <img src={img.url} alt={img.name} className="w-full h-full object-cover" />
            <div className="absolute inset-0 bg-black/40 opacity-0 group-hover:opacity-100 transition-opacity flex flex-col justify-end p-3">
              <span className="text-white text-xs font-medium truncate w-full">{img.name}</span>
              {img.hash && (
                <span className="text-white/70 text-[10px] flex items-center gap-1 mt-1">
                   <Fingerprint size={10} /> Hash ID: {img.hash.substring(0,8)}...
                </span>
              )}
            </div>
            <div className="absolute top-2 right-2 bg-green-500 text-white text-[10px] px-2 py-0.5 rounded-full font-bold shadow-sm">
              已保护
            </div>
          </div>
        ))}
        
        <div 
          onClick={() => galleryInputRef.current?.click()}
          className="aspect-square bg-slate-50 rounded-xl border-2 border-dashed border-slate-300 flex flex-col items-center justify-center cursor-pointer hover:bg-slate-100 text-slate-400 hover:text-slate-600 transition-colors"
        >
          <Upload size={32} />
          <span className="text-sm mt-2 font-medium">添加图片</span>
        </div>
      </div>
    </div>
  );

  const renderAssessment = () => {
    // 1. Upload View
    if (!targetImage) {
      return (
        <div className="flex flex-col items-center justify-center h-[calc(100vh-200px)]">
          <div className="w-full max-w-xl text-center">
            <div 
              onClick={() => fileInputRef.current?.click()}
              className="bg-white p-12 rounded-3xl border-2 border-dashed border-slate-300 cursor-pointer hover:border-blue-500 hover:bg-blue-50 transition-all group shadow-sm hover:shadow-lg"
            >
              <div className="w-20 h-20 bg-blue-100 text-blue-600 rounded-full flex items-center justify-center mx-auto mb-6 group-hover:scale-110 transition-transform">
                <ShieldCheck size={40} />
              </div>
              <h3 className="text-xl font-bold text-slate-800 mb-2">上传待检测图片</h3>
              <p className="text-slate-500 mb-6">系统将自动运行 pHash 快速查重与 Gemini 深度语义鉴定。</p>
              <button className="bg-blue-600 text-white px-8 py-3 rounded-full font-bold shadow-lg shadow-blue-200 group-hover:shadow-blue-300 transition-transform active:scale-95">
                上传文件
              </button>
              <input 
                type="file" 
                ref={fileInputRef} 
                className="hidden" 
                accept="image/*" 
                onChange={handleTargetUpload} 
              />
            </div>
          </div>
        </div>
      );
    }

    const matchedRefImage = selectedResult 
      ? gallery.find(g => g.id === selectedResult.referenceImageId) 
      : null;
    
    const hasHighRisk = results.some(r => r.scores.total >= 60);

    return (
      <div className="flex h-full min-h-[calc(100vh-140px)] bg-white rounded-xl border border-slate-200 overflow-hidden shadow-sm">
        {/* Left: Input & Matches List */}
        <div className="w-80 border-r border-slate-200 flex flex-col bg-slate-50">
          <div className="p-4 border-b border-slate-200 bg-white">
            <h3 className="text-xs font-bold text-slate-400 uppercase tracking-wider mb-3">待测图片</h3>
            <div className="relative aspect-video rounded-lg overflow-hidden border border-slate-200 bg-slate-100 group">
              <img src={targetImage.url} alt="Target" className="w-full h-full object-contain" />
              <button 
                onClick={() => setTargetImage(null)}
                className="absolute top-2 right-2 bg-black/50 hover:bg-black/70 text-white p-1.5 rounded-full opacity-0 group-hover:opacity-100 transition-opacity"
              >
                <RefreshCw size={14} />
              </button>
            </div>
            
            {status.step === 'idle' && (
              <button 
                onClick={startAssessment}
                className="w-full mt-4 bg-blue-600 hover:bg-blue-700 text-white py-2.5 rounded-lg font-bold flex items-center justify-center gap-2 transition-all shadow-md shadow-blue-200 active:scale-95"
              >
                <Search size={18} />
                开始全库扫描
              </button>
            )}

            {status.step !== 'idle' && status.step !== 'complete' && (
              <div className="mt-4">
                <div className="flex justify-between text-xs font-bold text-blue-600 mb-1">
                  <span>{status.progress}% 扫描中...</span>
                </div>
                <div className="w-full bg-blue-100 rounded-full h-1.5 overflow-hidden mb-2">
                  <div 
                    className="bg-blue-600 h-1.5 rounded-full transition-all duration-300 ease-linear" 
                    style={{ width: `${status.progress}%` }}
                  ></div>
                </div>
                <p className="text-[10px] text-slate-500 truncate">{status.currentFile}</p>
              </div>
            )}
          </div>

          <div className="flex-1 overflow-y-auto p-2 space-y-2">
            {status.step === 'complete' && results.length === 0 && (
               <div className="text-center py-12 px-4 text-slate-400">
                 <CheckCircle size={32} className="mx-auto text-green-500 mb-2" />
                 <p className="font-medium text-slate-600 text-sm">全库安全</p>
                 <p className="text-xs mt-1">未发现任何相似风险</p>
               </div>
            )}

            {results.map((res, idx) => {
              const ref = gallery.find(g => g.id === res.referenceImageId);
              const isActive = selectedResult?.referenceImageId === res.referenceImageId;
              const isHighRisk = res.scores.total >= 60;
              
              return (
                <div 
                  key={res.referenceImageId}
                  onClick={() => setSelectedResult(res)}
                  className={`p-2 rounded-lg border cursor-pointer transition-all flex gap-3 items-center group ${
                    isActive
                      ? 'bg-white border-blue-500 shadow-sm' 
                      : 'bg-white border-transparent hover:border-slate-300 hover:bg-white'
                  }`}
                >
                  <div className="relative w-12 h-12 rounded bg-slate-200 overflow-hidden shrink-0">
                     <img src={ref?.url} className="w-full h-full object-cover" />
                     {res.pHashMatch && (
                       <div className="absolute inset-0 bg-red-500/20 ring-2 ring-inset ring-red-500" />
                     )}
                  </div>
                  <div className="flex-1 min-w-0">
                    <div className="flex justify-between items-center mb-0.5">
                      <span className={`text-xs font-bold ${isActive ? 'text-blue-700' : 'text-slate-700'} truncate pr-2`}>
                        {ref?.name}
                      </span>
                      <span className={`text-[10px] font-bold px-1.5 py-0.5 rounded ${
                        isHighRisk ? 'bg-red-100 text-red-600' : 'bg-green-100 text-green-600'
                      }`}>
                        {res.scores.total}分
                      </span>
                    </div>
                    <div className="text-[10px] text-slate-500 flex items-center gap-1">
                       {res.pHashMatch && <Fingerprint size={10} className="text-red-500" />}
                       <span className="truncate">{res.pHashMatch ? 'Hash 命中' : (isHighRisk ? '语义相似' : '低风险')}</span>
                    </div>
                  </div>
                  <ChevronRight size={14} className={`text-slate-300 ${isActive ? 'text-blue-500' : 'group-hover:text-slate-400'}`} />
                </div>
              );
            })}
          </div>
        </div>

        {/* Right: Detailed Analysis */}
        <div className="flex-1 overflow-y-auto bg-white">
          {selectedResult && matchedRefImage ? (
            <div className="p-8 max-w-5xl mx-auto">
              
              {/* Top Summary Banner */}
              <div className={`rounded-2xl p-6 mb-8 flex items-center gap-6 border ${
                selectedResult.scores.total >= 60 
                  ? 'bg-red-50 border-red-100' 
                  : 'bg-green-50 border-green-100'
              }`}>
                 <div className={`p-4 rounded-full bg-white shadow-sm ${
                   selectedResult.scores.total >= 60 ? 'text-red-500' : 'text-green-500'
                 }`}>
                   {selectedResult.scores.total >= 60 ? <AlertTriangle size={32} /> : <ShieldCheck size={32} />}
                 </div>
                 <div className="flex-1">
                   <h2 className={`text-2xl font-bold ${selectedResult.scores.total >= 60 ? 'text-red-900' : 'text-green-900'}`}>
                     {selectedResult.scores.total >= 80 ? "严重侵权风险警告" : 
                      selectedResult.scores.total >= 60 ? "中度相似风险" : "安全 - 仅微弱相似"}
                   </h2>
                   <p className="text-sm mt-1 opacity-80 text-slate-800">
                     对比源：{matchedRefImage.name} 
                     {selectedResult.pHashMatch && <span className="ml-2 font-bold">(pHash 指纹一致)</span>}
                   </p>
                 </div>
                 <div className="text-center px-6 border-l border-black/5">
                    <div className="text-4xl font-black text-slate-900">{selectedResult.scores.total}</div>
                    <div className="text-[10px] font-bold text-slate-500 uppercase tracking-widest mt-1">综合评分</div>
                 </div>
              </div>

              {/* Visual Comparison */}
              <div className="grid grid-cols-2 gap-8 mb-8">
                <div>
                   <span className="text-xs font-bold text-slate-400 uppercase tracking-wider mb-2 block">上传的图片 (待测)</span>
                   <div className="bg-slate-50 border border-slate-200 rounded-xl p-2">
                     <img src={targetImage.url} className="w-full h-64 object-contain" />
                   </div>
                </div>
                <div>
                   <span className="text-xs font-bold text-slate-400 uppercase tracking-wider mb-2 block">库中原图 (受保护)</span>
                   <div className="bg-slate-50 border border-slate-200 rounded-xl p-2">
                     <img src={matchedRefImage.url} className="w-full h-64 object-contain" />
                   </div>
                </div>
              </div>

              {/* Evidence & Chart Row */}
              <div className="grid grid-cols-1 lg:grid-cols-12 gap-8 mb-8">
                {/* Evidence List */}
                <div className="lg:col-span-7 bg-white">
                  <h3 className="text-lg font-bold text-slate-900 mb-4 flex items-center gap-2">
                    <Search size={20} className="text-blue-500"/>
                    视觉取证证据链
                  </h3>
                  
                  <div className="space-y-4">
                    <div className="bg-red-50/50 rounded-xl p-4 border border-red-100">
                      <span className="text-xs font-bold text-red-500 uppercase tracking-wide block mb-2">⚠ 关键相似点 (Evidence)</span>
                      {selectedResult.evidence.similarities.length > 0 ? (
                        <ul className="space-y-2">
                          {selectedResult.evidence.similarities.map((item, i) => (
                            <li key={i} className="flex gap-2 text-sm text-slate-700">
                              <span className="text-red-400 shrink-0">•</span>
                              {item}
                            </li>
                          ))}
                        </ul>
                      ) : (
                        <span className="text-sm text-slate-400 italic">未发现明显相似特征</span>
                      )}
                    </div>

                    <div className="bg-green-50/50 rounded-xl p-4 border border-green-100">
                      <span className="text-xs font-bold text-green-600 uppercase tracking-wide block mb-2">🛡 独有特征 (Defense)</span>
                      {selectedResult.evidence.differences.length > 0 ? (
                        <ul className="space-y-2">
                          {selectedResult.evidence.differences.map((item, i) => (
                            <li key={i} className="flex gap-2 text-sm text-slate-700">
                              <span className="text-green-400 shrink-0">•</span>
                              {item}
                            </li>
                          ))}
                        </ul>
                      ) : (
                        <span className="text-sm text-slate-400 italic">未发现显著差异</span>
                      )}
                    </div>
                  </div>
                </div>

                {/* Radar Chart */}
                <div className="lg:col-span-5 bg-slate-50 rounded-2xl p-4 border border-slate-100">
                  <div className="h-64">
                    <RiskChart scores={selectedResult.scores} />
                  </div>
                </div>
              </div>

              {/* AI Analysis Text */}
              <div className="mb-8">
                <h3 className="text-lg font-bold text-slate-900 mb-3">AI 鉴定结论</h3>
                <div className="bg-slate-50 border-l-4 border-blue-500 p-5 rounded-r-lg text-slate-700 leading-relaxed text-sm shadow-sm">
                  {selectedResult.analysisText}
                </div>
              </div>

              {/* Modification Suggestion */}
              {selectedResult.scores.total >= 50 && (
                <div className="border-t border-slate-100 pt-8">
                  <div className="flex items-center gap-3 mb-5">
                    <div className="p-2 bg-indigo-100 text-indigo-600 rounded-lg">
                      <Wand2 size={24} />
                    </div>
                    <h3 className="text-xl font-bold text-slate-900">智能修改与规避</h3>
                  </div>

                  <div className="bg-gradient-to-r from-indigo-50 to-white border border-indigo-100 rounded-2xl p-6">
                    <div className="mb-6">
                      <h4 className="text-sm font-bold text-indigo-900 uppercase tracking-wide mb-2">修改建议</h4>
                      <p className="text-indigo-800 font-medium">
                        {selectedResult.modificationSuggestion || "建议调整构图视角和主要配色，以产生差异化。"}
                      </p>
                    </div>
                    
                    {!refinedPrompt ? (
                      <button 
                        onClick={handleGeneratePrompt}
                        disabled={isGeneratingPrompt}
                        className="bg-indigo-600 hover:bg-indigo-700 text-white px-6 py-3 rounded-xl font-bold shadow-lg shadow-indigo-200 transition-all flex items-center gap-2 active:scale-95"
                      >
                         {isGeneratingPrompt ? (
                           <>
                             <RefreshCw className="animate-spin" size={18} />
                             正在生成 Prompt...
                           </>
                         ) : (
                           <>
                            <Wand2 size={18} />
                            一键生成去风险提示词 (Prompt)
                           </>
                         )}
                      </button>
                    ) : (
                      <div className="bg-white rounded-xl border border-indigo-200 p-5 shadow-sm">
                        <div className="flex justify-between items-center mb-3">
                           <span className="text-xs font-bold text-indigo-500 uppercase">推荐的 Safe Prompt</span>
                           <button onClick={() => setRefinedPrompt(null)} className="text-xs text-indigo-600 hover:underline">刷新</button>
                        </div>
                        <div className="text-slate-600 text-sm font-mono bg-slate-50 p-3 rounded mb-4 border border-slate-100">
                          {refinedPrompt}
                        </div>
                        <div className="flex gap-3">
                          <button className="flex-1 bg-slate-900 text-white text-sm font-bold py-2 rounded-lg hover:bg-slate-800">
                            复制提示词
                          </button>
                        </div>
                      </div>
                    )}
                  </div>
                </div>
              )}

            </div>
          ) : (
            <div className="h-full flex flex-col items-center justify-center text-slate-300">
              <div className="w-24 h-24 bg-slate-50 rounded-full flex items-center justify-center mb-4">
                 <BarChart3 size={40} className="text-slate-200" />
              </div>
              <p className="font-medium">请从左侧列表选择图片以查看详细分析报告</p>
            </div>
          )}
        </div>
      </div>
    );
  };

  return (
    <div className="min-h-screen bg-slate-50 flex flex-col font-sans text-slate-900">
      <header className="bg-white border-b border-slate-200 sticky top-0 z-50 shadow-sm">
        <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 h-16 flex items-center justify-between">
          <div className="flex items-center gap-2.5">
            <div className="bg-slate-900 text-white p-2 rounded-lg shadow-md shadow-slate-200">
              <ShieldCheck size={20} />
            </div>
            <span className="font-bold text-xl tracking-tight text-slate-900">
              Copyright<span className="text-blue-600">Guard</span> AI
            </span>
          </div>
          
          <div className="flex bg-slate-100 p-1 rounded-lg">
            <button 
              onClick={() => setAppState(AppState.GALLERY)}
              className={`px-5 py-1.5 rounded-md text-sm font-bold transition-all ${appState === AppState.GALLERY ? 'bg-white text-slate-900 shadow-sm ring-1 ring-black/5' : 'text-slate-500 hover:text-slate-700'}`}
            >
              资产库
            </button>
            <button 
              onClick={() => setAppState(AppState.ASSESS)}
              className={`px-5 py-1.5 rounded-md text-sm font-bold transition-all ${appState === AppState.ASSESS ? 'bg-white text-slate-900 shadow-sm ring-1 ring-black/5' : 'text-slate-500 hover:text-slate-700'}`}
            >
              智能鉴别
            </button>
          </div>
        </div>
      </header>

      <main className="flex-1 max-w-[1400px] w-full mx-auto p-4 sm:px-6 lg:px-8 py-6">
        {appState === AppState.GALLERY ? renderGallery() : renderAssessment()}
      </main>
    </div>
  );
};

export default App;