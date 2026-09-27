import {
  analyzeDocument, computeHeadingAnchors, findBrokenAnchorLinks,
  renderTargetMarkdown, syncAnchorLinks,
} from '@/lib/markdown'
import { seedGlossary, seedSegments } from '@/lib/seed'
import type { Segment } from '@/lib/types'

const clone = <T,>(v: T): T => JSON.parse(JSON.stringify(v)) as T
let failures = 0
const check = (name: string, actual: unknown, expected: unknown) => {
  const ok = JSON.stringify(actual) === JSON.stringify(expected)
  if (!ok) failures += 1
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${ok ? '' : `\n  expected: ${JSON.stringify(expected)}\n  actual:   ${JSON.stringify(actual)}`}`)
}

// 1. 种子文档锚点：显式锚点优先、重复标题按序区分
const anchors = computeHeadingAnchors(seedSegments)
check('explicit anchor wins', anchors.find((a) => a.segmentId === 'seg-03'), { segmentId: 'seg-03', sourceAnchor: 'prereqs', targetAnchor: 'prereqs' })
check('duplicate translated headings get ordered suffixes', [
  anchors.find((a) => a.segmentId === 'seg-11')?.targetAnchor,
  anchors.find((a) => a.segmentId === 'seg-12')?.targetAnchor,
], ['常见问题', '常见问题-1'])
check('untranslated heading falls back to source anchor', anchors.find((a) => a.segmentId === 'seg-10')?.targetAnchor, 'upgrade-notes')

// 2. 初始同步：目录里的旧英文锚点被改写为译文锚点，未变化的保持不变
const synced = syncAnchorLinks(clone(seedSegments))
const toc = synced.segments.find((s) => s.id === 'seg-toc')!
check('toc links synced to translated anchors', toc.targetText, '- [前置条件](#prereqs)\n- [Upgrade Notes](#upgrade-notes)\n- [常见问题](#常见问题)\n- [常见问题（运维）](#常见问题-1)')
check('two links updated', synced.updated, 2)

// 3. 标题译文变化时同步目录链接（含再次改名：previous anchor 也能追上）
const afterFirst = clone(seedSegments).map((s) => s.id === 'seg-10' ? { ...s, targetText: '## 升级说明' } : s)
const prevAnchors = computeHeadingAnchors(afterFirst.map((s) => s.id === 'seg-10' ? { ...s, targetText: '' } : s))
const resynced = syncAnchorLinks(syncAnchorLinks(afterFirst, prevAnchors).segments)
const toc2 = resynced.segments.find((s) => s.id === 'seg-toc')!
check('heading edit syncs toc link', toc2.targetText.includes('(#升级说明)'), true)

const renamed = resynced.segments.map((s) => s.id === 'seg-10' ? { ...s, targetText: '## 更新说明' } : s)
const resynced2 = syncAnchorLinks(renamed, computeHeadingAnchors(resynced.segments))
check('second rename follows previous anchor', resynced2.segments.find((s) => s.id === 'seg-toc')!.targetText.includes('(#更新说明)'), true)

// 4. 导出渲染：未翻译片段回退源文时链接同样被修正
const rendered = renderTargetMarkdown(synced.segments)
check('render contains synced anchors', rendered.includes('(#常见问题-1)') && rendered.includes('(#prereqs)'), true)

// 5. 失效链接检测：找不到目标时报告所在标题
const brokenDoc = clone(seedSegments)
brokenDoc.find((s) => s.id === 'seg-toc')!.targetText += '\n- [Ghost](#no-such-section)'
const broken = findBrokenAnchorLinks(brokenDoc)
check('broken link detected with section title', broken, [{ segmentId: 'seg-toc', segmentIndex: 2, href: '#no-such-section', sectionTitle: '部署指南' }])
check('healthy doc has no broken links', findBrokenAnchorLinks(synced.segments), [])

// 6. 术语检查不再把已同步的目录锚点误报为链接不一致
const issues = analyzeDocument(synced.segments, seedGlossary)
check('no false link-mismatch on synced toc', issues.filter((i) => i.segmentId === 'seg-toc' && i.type === 'link-mismatch'), [])

// 7. 代码块中的类链接文本不被改写
const codeDoc: Segment[] = [
  { id: 'h1', index: 1, kind: 'heading', sourceText: '## Setup', targetText: '## 安装', status: 'draft', protectedTokens: [], note: '' },
  { id: 'c1', index: 2, kind: 'code', sourceText: '```\n[see](#setup)\n```', targetText: '```\n[see](#setup)\n```', status: 'confirmed', protectedTokens: [], note: '' },
]
check('code block untouched by sync', syncAnchorLinks(codeDoc).segments[1].targetText, '```\n[see](#setup)\n```')
check('code block not flagged as broken', findBrokenAnchorLinks(codeDoc), [])

console.log(failures ? `\n${failures} failure(s)` : '\nall checks passed')
process.exit(failures ? 1 : 0)
