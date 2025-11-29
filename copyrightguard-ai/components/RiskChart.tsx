import React from 'react';
import { Radar, RadarChart, PolarGrid, PolarAngleAxis, PolarRadiusAxis, ResponsiveContainer, Tooltip } from 'recharts';
import { RiskScores } from '../types';

interface RiskChartProps {
  scores: RiskScores;
}

const RiskChart: React.FC<RiskChartProps> = ({ scores }) => {
  const data = [
    { subject: '语义内容 (40)', A: scores.semantic, fullMark: 40 },
    { subject: '视觉结构 (40)', A: scores.structure, fullMark: 40 },
    { subject: '合规意图 (20)', A: scores.compliance, fullMark: 20 },
  ];

  return (
    <div className="w-full h-64 bg-white rounded-lg p-2">
      <ResponsiveContainer width="100%" height="100%">
        <RadarChart cx="50%" cy="50%" outerRadius="70%" data={data}>
          <PolarGrid />
          <PolarAngleAxis dataKey="subject" tick={{ fill: '#64748b', fontSize: 12 }} />
          <PolarRadiusAxis angle={30} domain={[0, 'auto']} tick={false} />
          <Radar
            name="风险评分"
            dataKey="A"
            stroke="#ef4444"
            fill="#ef4444"
            fillOpacity={0.6}
          />
          <Tooltip 
             contentStyle={{ backgroundColor: '#fff', borderRadius: '8px', border: '1px solid #e2e8f0' }}
             itemStyle={{ color: '#ef4444', fontWeight: 'bold' }}
          />
        </RadarChart>
      </ResponsiveContainer>
    </div>
  );
};

export default RiskChart;