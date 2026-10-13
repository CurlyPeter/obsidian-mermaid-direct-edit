import type { LegendItem } from './legend';

export type LegendKind = 'component' | 'anchor' | 'evolve' | 'inertia' | 'note' | 'annotation' | 'accelerator' | 'deaccelerator' | 'pipeline' | 'group';

/** What the legend of a Wardley map adds. Icons are fixed markup written here, never built from map text. */
export const WARDLEY_LEGEND: readonly LegendItem[] = [
	['component', 'Component', "<circle cx='12' cy='8' r='5' fill='white' stroke='currentColor' stroke-width='1.5'/>"],
	['anchor', 'Anchor', "<text x='12' y='12' text-anchor='middle' font-size='11' font-weight='bold' fill='currentColor'>A</text>"],
	['evolve', 'Evolve', "<line x1='2' y1='8' x2='19' y2='8' stroke='#e45' stroke-dasharray='3 2'/><path d='M18 5l4 3-4 3z' fill='#e45'/>"],
	['inertia', 'Inertia', "<line x1='12' y1='2' x2='12' y2='14' stroke='currentColor' stroke-width='4'/>"],
	['note', 'Note', "<text x='12' y='12' text-anchor='middle' font-size='10' font-weight='bold' fill='currentColor'>Aa</text>"],
	['annotation', 'Annotation', "<circle cx='12' cy='8' r='6.5' fill='white' stroke='currentColor' stroke-width='1.2'/><text x='12' y='11' text-anchor='middle' font-size='8' font-weight='bold' fill='#222'>1</text>"],
	['accelerator', 'Accelerator', "<path d='M3 5h11V2l7 6-7 6v-3H3z' fill='white' stroke='currentColor'/>"],
	['deaccelerator', 'Deaccelerator', "<path d='M21 5H10V2L3 8l7 6v-3h11z' fill='white' stroke='currentColor'/>"],
	['pipeline', 'Pipeline', "<rect x='2' y='4' width='20' height='8' rx='2' fill='none' stroke='currentColor'/><circle cx='7' cy='8' r='2' fill='white' stroke='currentColor'/><circle cx='17' cy='8' r='2' fill='white' stroke='currentColor'/>"],
	['group', 'Group', "<rect x='1.5' y='1.5' width='21' height='13' rx='6.5' fill='none' stroke='currentColor' stroke-dasharray='3 2'/><circle cx='8' cy='8' r='2.5' fill='white' stroke='currentColor'/><circle cx='16' cy='8' r='2.5' fill='white' stroke='currentColor'/>"],
];
