import * as echarts from 'echarts';
import type { AnalysisResult } from '../shared/types.js';

/** ECharts 图表：雷达（四维评分）+ 柱状（类别完整度） */

let radarChart: echarts.ECharts | null = null;
let barChart: echarts.ECharts | null = null;

export function renderCharts(result: AnalysisResult) {
  const radarEl = document.getElementById('chart-radar');
  const barEl = document.getElementById('chart-bar');
  if (!radarEl || !barEl) return;

  radarChart?.dispose();
  barChart?.dispose();

  radarChart = echarts.init(radarEl);
  radarChart.setOption({
    radar: {
      indicator: [
        { name: '完整度', max: 1 },
        { name: '临近度', max: 1 },
        { name: '覆盖率', max: 1 },
        { name: '多样性', max: 1 }
      ],
      radius: '62%',
      axisName: { color: '#5a6478', fontSize: 12 }
    },
    series: [
      {
        type: 'radar',
        data: [
          {
            value: [
              round2(result.score.dims.completeness),
              round2(result.score.dims.proximity),
              round2(result.score.dims.coverage ?? 0),
              round2(result.score.dims.diversity)
            ],
            name: '体检得分',
            areaStyle: { color: 'rgba(47, 111, 237, 0.25)' },
            lineStyle: { color: '#2f6fed' },
            itemStyle: { color: '#2f6fed' }
          }
        ]
      }
    ]
  });

  barChart = echarts.init(barEl);
  barChart.setOption({
    grid: { left: 80, right: 20, top: 10, bottom: 24 },
    xAxis: { type: 'value', axisLabel: { fontSize: 10 } },
    yAxis: {
      type: 'category',
      data: result.score.details.map((d) => d.name).reverse(),
      axisLabel: { fontSize: 11 }
    },
    series: [
      {
        type: 'bar',
        data: result.score.details.map((d) => d.count).reverse(),
        itemStyle: { color: '#2f6fed', borderRadius: [0, 4, 4, 0] },
        label: { show: true, position: 'right', fontSize: 10, formatter: '{c}' },
        barMaxWidth: 12
      },
      {
        type: 'bar',
        data: result.score.details.map((d) => d.ideal).reverse(),
        itemStyle: { color: 'rgba(90, 100, 120, 0.18)', borderRadius: [0, 4, 4, 0] },
        tooltip: { show: false },
        barMaxWidth: 12,
        barGap: '-100%'
      }
    ]
  });

  window.addEventListener('resize', () => {
    radarChart?.resize();
    barChart?.resize();
  }, { once: true });
}

function round2(x: number): number {
  return Math.round(x * 100) / 100;
}
