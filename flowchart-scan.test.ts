// @vitest-environment happy-dom
import { describe, expect, it } from 'vitest';
import { ScanError, scan } from './flowchart-scan';
import { ALL, DEMO, REAL } from './flowchart.fixtures';
import { agrees } from './test-mermaid';

const CASES = [
	'graph TD;A-->B;',
	'flowchart TD\nA-->B;C-->D',
	'flowchart\nA --> B',
	'graph LR\n  A --- B --- C & D',
	'flowchart TD\nA[a;b] --> B',
	'flowchart TD\nA&B --> C',
	'flowchart TD\nA & B-->C',
	'flowchart TD\nA---oB',
	'flowchart TD\nA --o B',
	'flowchart TD\nA -- text --> B -- two --> C',
	'flowchart TD\nA-->|x|B',
	'flowchart TD\nA-- x -->B',
	'flowchart TD\nA --> |x| B',
	'flowchart TD\nA -->|"q|x"| B',
	'flowchart TD\nA -- "q|x" --> B',
	'flowchart TD\nA:::c --> B:::d\nclassDef c fill:#f00',
	'flowchart TD\nA[x]:::c',
	'flowchart TD\nA@{ shape: rect } --> B',
	'flowchart TD\nA@{\n  shape: rect\n  label: "x}y"\n} --> B',
	'flowchart TD\nA --> B --> A',
	'flowchart TD\nA-.text.->B',
	'flowchart TD\nA ==text==> B',
	'flowchart TD\nA<-- x -->B',
	'flowchart TD\nA o-- x --o B',
	'flowchart TD\nA <-.-> B\nA <==> B\nA x-.-x B',
	'flowchart TD\nA --> B\nA --> B\nA e1@--> B\nA --> B',
	'flowchart TD\nA e1@--> B & C',
	'flowchart TD\nA & B e1@--> C',
	'flowchart TD\nA e1@--> B\nA e1@--> C',
	'flowchart TD\nA --> B\nB ---> C\nC ----> D\nD -..-> E\nE ====> F\nF ~~~~ G',
	'flowchart TD\nA("x")-->B',
	'flowchart TD\nA["x" ]-->B',
	'flowchart TD\nA-->B\n  %% comment\nB-->C',
	'flowchart TD\nsubgraph "Title"\nA\nend',
	'flowchart TD\nsubgraph "Two words"\nA\nend',
	'flowchart TD\nsubgraph s1 ["Two words"]\nA\nend',
	'flowchart TD\nsubgraph s1[Title x]\nA\nend',
	'flowchart TD\nsubgraph One two\nA\nend\nsubgraph Three four\nB\nend',
	'flowchart LR\nA --> B\nsubgraph S\nB --> C\nend\nsubgraph T\nC\nB\nend',
	'flowchart LR\nsubgraph O [Outer]\n  subgraph I [Inner]\n    p --> q\n  end\n  q --> r\nend\nO --> I',
	'flowchart TD\nstyle Z fill:#f00\nA-->B',
	'flowchart TD\nclass Z foo\nA-->B',
	'flowchart TD\nA ~~~|x| B',
	'flowchart TD\na-1 --> b.c\nä1 --> Ü2',
	'flowchart TD\nendpoint --> B',
	'flowchart TD\n  A[Start] --> B{Is it?}\n  B -- Yes --> C[OK]\n  C --> D[Rethink]\n  D --> B\n  B -- No ----> E[End]',
	'flowchart LR\n  A[Hard edge] -->|Link text| B(Round edge)\n  B --> C{Decision}\n  C -->|One| D[Result one]\n  C -->|Two| E[Result two]',
	'%%{init: {"flowchart": {"curve": "basis"}}}%%\nflowchart TD\nA --> B',
	'flowchart TD\nA[/x/] --> B[\\y\\] --> C[/z\\] --> D[\\w/]',
	'flowchart TD\nA(-ellipse-) --> B',
	'flowchart TD\nA(-"a/b (c) [d]"-) --> B',
	'flowchart TD\nA["`**md** text`"] -->|"`*it*`"| B',
	'flowchart TD\n  A --> B\n  click A "https://example.com" "tip"\n  linkStyle default stroke:#f00',
	'flowchart LR\n  A e1@--> B\n  e1@{ animate: true }\n  B e2@==> C\n  e2@{ animation: fast }',
];

describe('scan agrees with Mermaid 12.1', () => {
	it('on the demo and all-elements diagrams', async () => {
		const demo = await agrees(DEMO);
		expect(demo.edges.length).toBe(12);
		const all = await agrees(ALL);
		expect(all.edges.length).toBe(43);
	});

	it.each(REAL.map((s, i) => [i, s]))('on real-world diagram %i', async (_i, src) => {
		await agrees(src as string);
	});

	it.each(CASES)('on %j', async src => {
		await agrees(src);
	});
});

describe('scan', () => {
	it('records where each part sits', () => {
		const src = 'flowchart LR\n  A[Start] -->|go| B{Check}';
		const f = scan(src);
		const [a, b] = [f.edges[0].from, f.edges[0].to];
		expect(src.slice(a.start, a.end)).toBe('A[Start]');
		expect(src.slice(a.shape!.label.start, a.shape!.label.end)).toBe('Start');
		expect(src.slice(b.start, b.end)).toBe('B{Check}');
		const link = f.edges[0].chain.links[0];
		expect(src.slice(link.start, link.end)).toBe('-->|go|');
		expect(f.header.dir).toEqual({ start: 10, end: 12, value: 'LR' });
	});

	it('refuses what it does not understand', () => {
		expect(() => scan('flowchart TD\nA &B --> C')).toThrow(ScanError);
		expect(() => scan('sequenceDiagram\nA->>B: hi')).toThrow(ScanError);
		expect(() => scan('flowchart TD\nA --> B %% trailing comment')).toThrow(ScanError);
		expect(() => scan('flowchart TD\nsubgraph S\nA')).toThrow(ScanError);
	});
});
