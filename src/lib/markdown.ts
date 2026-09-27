import type { GlossaryTerm, Segment, SegmentKind, TranslationIssue } from './types'

const variablePattern = /\{\{[^{}]+\}\}|\{[A-Za-z_][\w.-]*\}|%\([^)]+\)[sd]|%[sd]/g
const linkPattern = /\[[^\]]+\]\(([^)]+)\)/g
const explicitAnchorPattern = /\{#([^}\s]+)\}/
const anchorLinkPattern = /\]\(#([^)\s]+)\)/g

export const unique = <T,>(items: T[]) => Array.from(new Set(items))
export const extractVariables = (text: string) => unique(text.match(variablePattern) ?? [])
export const extractLinks = (text: string) => unique(Array.from(text.matchAll(linkPattern), (match) => match[1]))
export const extractProtected = (text: string) => unique([...extractVariables(text), ...extractLinks(text)])

const safeDecode = (value: string) => {
  try { return decodeURIComponent(value) } catch { return value }
}

export const headingTitle = (text: string) =>
  text.replace(/^#{1,6}\s+/, '').replace(explicitAnchorPattern, '').trim()

export const explicitAnchor = (text: string): string | null => {
  const match = text.replace(/^#{1,6}\s+/, '').match(explicitAnchorPattern)
  return match ? match[1] : null
}

export const slugifyHeading = (text: string) =>
  headingTitle(text).toLowerCase().replace(/[^\p{L}\p{N}\s_-]/gu, '').replace(/\s+/g, '-')

export interface HeadingAnchor {
  segmentId: string
  sourceAnchor: string
  targetAnchor: string
}

const assignAnchors = (texts: string[]) => {
  const seen = new Map<string, number>()
  return texts.map((text) => {
    const base = explicitAnchor(text) ?? slugifyHeading(text)
    const count = seen.get(base) ?? 0
    seen.set(base, count + 1)
    return count ? `${base}-${count}` : base
  })
}

export const computeHeadingAnchors = (segments: Segment[]): HeadingAnchor[] => {
  const headings = segments.filter((segment) => segment.kind === 'heading')
  const sourceAnchors = assignAnchors(headings.map((segment) => segment.sourceText))
  const targetAnchors = assignAnchors(headings.map((segment) => segment.targetText.trim() ? segment.targetText : segment.sourceText))
  return headings.map((segment, index) => ({ segmentId: segment.id, sourceAnchor: sourceAnchors[index], targetAnchor: targetAnchors[index] }))
}

export const buildAnchorRemap = (segments: Segment[], previous?: HeadingAnchor[]): Map<string, string> => {
  const remap = new Map<string, string>()
  computeHeadingAnchors(segments).forEach((entry, index) => {
    if (entry.sourceAnchor && entry.targetAnchor && entry.sourceAnchor !== entry.targetAnchor) {
      remap.set(entry.sourceAnchor, entry.targetAnchor)
    }
    const before = previous?.[index]
    if (before && before.segmentId === entry.segmentId && before.targetAnchor && before.targetAnchor !== entry.targetAnchor) {
      remap.set(before.targetAnchor, entry.targetAnchor)
    }
  })
  return remap
}

export const rewriteAnchorLinks = (text: string, remap: Map<string, string>) => {
  if (!remap.size) return text
  return text.replace(anchorLinkPattern, (whole, anchor: string) => {
    const next = remap.get(anchor) ?? remap.get(safeDecode(anchor))
    return next ? `](#${next})` : whole
  })
}

export const syncAnchorLinks = (segments: Segment[], previous?: HeadingAnchor[]): { segments: Segment[]; updated: number } => {
  const remap = buildAnchorRemap(segments, previous)
  if (!remap.size) return { segments, updated: 0 }
  let updated = 0
  const next = segments.map((segment) => {
    if (segment.kind === 'code' || !segment.targetText) return segment
    const text = rewriteAnchorLinks(segment.targetText, remap)
    if (text === segment.targetText) return segment
    updated += Array.from(segment.targetText.matchAll(anchorLinkPattern)).filter((match) => remap.has(match[1]) || remap.has(safeDecode(match[1]))).length
    return { ...segment, targetText: text }
  })
  return { segments: next, updated }
}

export interface BrokenAnchorLink {
  segmentId: string
  segmentIndex: number
  href: string
  sectionTitle: string
}

export const findBrokenAnchorLinks = (segments: Segment[]): BrokenAnchorLink[] => {
  const remap = buildAnchorRemap(segments)
  const valid = new Set<string>()
  for (const { targetAnchor } of computeHeadingAnchors(segments)) {
    if (!targetAnchor) continue
    valid.add(targetAnchor)
    valid.add(safeDecode(targetAnchor))
  }
  const resolvable = (anchor: string) =>
    remap.has(anchor) || remap.has(safeDecode(anchor)) || valid.has(anchor) || valid.has(safeDecode(anchor))
  const broken: BrokenAnchorLink[] = []
  let sectionTitle = ''
  for (const segment of segments) {
    const text = segment.targetText || segment.sourceText
    if (segment.kind === 'heading') sectionTitle = headingTitle(text)
    if (segment.kind === 'code') continue
    for (const match of text.matchAll(anchorLinkPattern)) {
      if (!resolvable(match[1])) {
        broken.push({ segmentId: segment.id, segmentIndex: segment.index, href: `#${match[1]}`, sectionTitle })
      }
    }
  }
  return broken
}

export const segmentKind = (text: string, fencedCode: boolean): SegmentKind => {
  if (fencedCode || /^ {4}\S/m.test(text)) return 'code'
  if (/^#{1,6}\s+/.test(text)) return 'heading'
  if (extractLinks(text).length) return 'link'
  if (extractVariables(text).length) return 'variable'
  return 'paragraph'
}

export const parseMarkdown = (markdown: string): Segment[] => {
  const normalized = markdown.replace(/\r/g, '')
  const blocks: { text: string; code: boolean }[] = []
  const codeFence = /```[\s\S]*?```/g
  let cursor = 0
  for (const match of normalized.matchAll(codeFence)) {
    const before = normalized.slice(cursor, match.index).split(/\n{2,}/).filter((part) => part.trim())
    blocks.push(...before.map((text) => ({ text: text.trim(), code: false })))
    blocks.push({ text: match[0].trim(), code: true })
    cursor = (match.index ?? 0) + match[0].length
  }
  blocks.push(...normalized.slice(cursor).split(/\n{2,}/).filter((part) => part.trim()).map((text) => ({ text: text.trim(), code: false })))
  return blocks.map((block, index) => ({
    id: `segment-import-${index + 1}`,
    index: index + 1,
    kind: segmentKind(block.text, block.code),
    sourceText: block.text,
    targetText: '',
    status: 'draft' as const,
    protectedTokens: extractProtected(block.text),
    note: '',
  }))
}

const meaningful = (text: string) => text.replace(/[#*_`>\s]/g, '').length > 1

export const analyzeSegment = (segment: Segment, glossary: GlossaryTerm[], anchorRemap?: Map<string, string>): TranslationIssue[] => {
  const issues: TranslationIssue[] = []
  const sourceVariables = extractVariables(segment.sourceText)
  const targetVariables = extractVariables(segment.targetText)
  const sourceLinks = extractLinks(segment.sourceText)
  const targetLinks = extractLinks(segment.targetText)
  if (meaningful(segment.sourceText) && !segment.targetText.trim()) {
    issues.push({ id: `${segment.id}-missing`, segmentId: segment.id, type: 'missing-translation', severity: 'error', message: '译文为空，存在漏译。' })
  }
  const missingVariables = sourceVariables.filter((token) => !targetVariables.includes(token))
  if (missingVariables.length) {
    issues.push({ id: `${segment.id}-variable`, segmentId: segment.id, type: 'missing-variable', severity: 'error', message: `缺少变量占位符：${missingVariables.join('、')}`, expected: missingVariables.join(' ') })
  }
  const expectedLinks = sourceLinks.map((url) => {
    if (!url.startsWith('#')) return url
    const mapped = anchorRemap?.get(url.slice(1)) ?? anchorRemap?.get(safeDecode(url.slice(1)))
    return mapped ? `#${mapped}` : url
  })
  const missingLinks = expectedLinks.filter((url) => !targetLinks.includes(url))
  if (missingLinks.length) {
    issues.push({ id: `${segment.id}-link`, segmentId: segment.id, type: 'link-mismatch', severity: 'warning', message: `链接目标不一致或缺失：${missingLinks.join('、')}`, expected: missingLinks.join(' ') })
  }
  for (const term of glossary) {
    const sourceHit = term.caseSensitive ? segment.sourceText.includes(term.source) : segment.sourceText.toLowerCase().includes(term.source.toLowerCase())
    if (sourceHit && segment.targetText && !segment.targetText.includes(term.target)) {
      issues.push({ id: `${segment.id}-term-${term.id}`, segmentId: segment.id, type: 'glossary', severity: 'warning', message: `术语“${term.source}”应译为“${term.target}”。`, expected: term.target })
    }
  }
  if (segment.kind === 'code' && segment.targetText && segment.sourceText !== segment.targetText) {
    issues.push({ id: `${segment.id}-code`, segmentId: segment.id, type: 'code-format', severity: 'error', message: '代码块应保持原样，不能翻译或改动格式。' })
  }
  return issues
}

export const analyzeDocument = (segments: Segment[], glossary: GlossaryTerm[]) => {
  const anchorRemap = buildAnchorRemap(segments)
  return segments.flatMap((segment) => segment.status === 'confirmed' ? [] : analyzeSegment(segment, glossary, anchorRemap))
}

export const renderTargetMarkdown = (segments: Segment[]) => {
  const remap = buildAnchorRemap(segments)
  return segments.map((segment) => {
    const text = segment.targetText || segment.sourceText
    return segment.kind === 'code' ? text : rewriteAnchorLinks(text, remap)
  }).join('\n\n')
}
