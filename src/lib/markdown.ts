import type { BrokenAnchorLink, GlossaryTerm, Segment, SegmentKind, TocLinkRewrite, TocSyncResult, TranslationIssue } from './types'

const variablePattern = /\{\{[^{}]+\}\}|\{[A-Za-z_][\w.-]*\}|%\([^)]+\)[sd]|%[sd]/g
const linkPattern = /\[[^\]]+\]\(([^)]+)\)/g

export const unique = <T,>(items: T[]) => Array.from(new Set(items))
export const extractVariables = (text: string) => unique(text.match(variablePattern) ?? [])
export const extractLinks = (text: string) => unique(Array.from(text.matchAll(linkPattern), (match) => match[1]))
export const extractProtected = (text: string) => unique([...extractVariables(text), ...extractLinks(text)])

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

export const analyzeSegment = (segment: Segment, glossary: GlossaryTerm[]): TranslationIssue[] => {
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
  const missingLinks = sourceLinks.filter((url) => !targetLinks.includes(url))
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
  const issues = segments.flatMap((segment) => segment.status === 'confirmed' ? [] : analyzeSegment(segment, glossary))
  for (const broken of syncTocLinks(segments).brokenLinks) {
    issues.push({
      id: `${broken.segmentId}-anchor-${broken.anchor}`,
      segmentId: broken.segmentId,
      type: 'anchor-mismatch' as const,
      severity: 'error' as const,
      message: `目录链接 ${broken.anchor} 在译文中找不到目标标题（位于“${broken.heading}”），导出后会失效。`,
      expected: broken.anchor,
    })
  }
  return issues
}

export const renderTargetMarkdown = (segments: Segment[]) =>
  segments.map((segment) => segment.targetText || segment.sourceText).join('\n\n')

const explicitAnchorPattern = /\{#([A-Za-z0-9_:.-]+)\}\s*$/
const headingLinePattern = /^(#{1,6})\s+(.+?)\s*$/
// 目录等文内跳转链接：仅匹配以 # 开头的片段链接，外部 URL（含其片段）不受影响
const tocLinkPattern = () => /\[([^\]]+)\]\((#[^)\s]+)([^)]*)\)/g

export interface ParsedHeading {
  level: number
  text: string
  explicitAnchor: string | null
}

export const parseHeading = (block: string): ParsedHeading | null => {
  const match = block.split('\n', 1)[0].match(headingLinePattern)
  if (!match) return null
  let text = match[2]
  let explicitAnchor: string | null = null
  const anchorMatch = text.match(explicitAnchorPattern)
  if (anchorMatch) {
    explicitAnchor = anchorMatch[1]
    text = text.slice(0, anchorMatch.index).trim()
  }
  return { level: match[1].length, text, explicitAnchor }
}

// 与 GitHub / 常见文档站一致的标题锚点规则：小写、去标点、空格转连字符，保留中日韩等文字
export const slugifyHeading = (text: string): string =>
  text
    .replace(/<[^>]+>/g, '')
    .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/[`*~]/g, '')
    .trim()
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\p{M}_\- ]/gu, '')
    .replace(/\s+/g, '-')

// 依次计算一组内容块中标题的锚点；作者写明的 {#anchor} 优先，自动锚点重复时按出现顺序加 -1、-2 后缀
export const buildHeadingAnchors = (blocks: string[]): (string | null)[] => {
  const seen = new Map<string, number>()
  return blocks.map((block) => {
    const heading = parseHeading(block)
    if (!heading) return null
    if (heading.explicitAnchor) return heading.explicitAnchor
    const base = slugifyHeading(heading.text)
    const occurrence = seen.get(base) ?? 0
    seen.set(base, occurrence + 1)
    return occurrence ? `${base}-${occurrence}` : base
  })
}

const findContainingHeading = (blocks: string[], position: number): string => {
  for (let index = position; index >= 0; index--) {
    const heading = parseHeading(blocks[index])
    if (heading) return heading.text
  }
  return '文档开头'
}

// 根据译文标题重算锚点并同步目录链接；找不到目标的链接会被记录，用于导出前拦截
export const syncTocLinks = (segments: Segment[]): TocSyncResult => {
  const exportTexts = segments.map((segment) => segment.targetText || segment.sourceText)
  const sourceAnchors = buildHeadingAnchors(segments.map((segment) => segment.sourceText))
  const exportAnchors = buildHeadingAnchors(exportTexts)
  const exportAnchorSet = new Set(exportAnchors.filter((anchor): anchor is string => Boolean(anchor)))
  const rewriteMap = new Map<string, string>()
  segments.forEach((_, index) => {
    const from = sourceAnchors[index]
    const to = exportAnchors[index]
    if (from && to && from !== to) rewriteMap.set(from, to)
  })
  const rewrites: TocLinkRewrite[] = []
  const brokenLinks: BrokenAnchorLink[] = []
  const syncedTexts = segments.map((segment, index) => {
    const synced = exportTexts[index].replace(tocLinkPattern(), (whole, label: string, anchor: string, suffix: string) => {
      const next = rewriteMap.get(anchor.slice(1))
      if (!next) return whole
      rewrites.push({ segmentId: segment.id, from: anchor, to: `#${next}` })
      return `[${label}](#${next}${suffix})`
    })
    for (const match of synced.matchAll(tocLinkPattern())) {
      if (!exportAnchorSet.has(match[2].slice(1))) {
        brokenLinks.push({ segmentId: segment.id, anchor: match[2], linkText: match[1], heading: findContainingHeading(exportTexts, index) })
      }
    }
    return synced
  })
  return { markdown: syncedTexts.join('\n\n'), rewrites, brokenLinks }
}
