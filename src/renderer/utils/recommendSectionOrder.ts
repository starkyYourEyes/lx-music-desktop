import { RECOMMEND_HOME_SECTION_IDS } from '@common/constants'

const recommendHomeSectionIdSet = new Set<LX.RecommendHomeSectionId>(RECOMMEND_HOME_SECTION_IDS)

export const normalizeRecommendHomeSectionOrder = (
  order?: readonly LX.RecommendHomeSectionId[] | null,
): LX.RecommendHomeSectionId[] => {
  const nextOrder: LX.RecommendHomeSectionId[] = []

  if (Array.isArray(order)) {
    for (const sectionId of order) {
      if (!recommendHomeSectionIdSet.has(sectionId)) continue
      if (nextOrder.includes(sectionId)) continue
      nextOrder.push(sectionId)
    }
  }

  for (const [index, sectionId] of RECOMMEND_HOME_SECTION_IDS.entries()) {
    if (nextOrder.includes(sectionId)) continue

    const nextDefaultSectionIds = RECOMMEND_HOME_SECTION_IDS.slice(index + 1)
    const insertIndex = nextOrder.findIndex(id => nextDefaultSectionIds.includes(id))
    if (insertIndex < 0) nextOrder.push(sectionId)
    else nextOrder.splice(insertIndex, 0, sectionId)
  }

  return nextOrder
}

export const moveRecommendHomeSection = (
  order: readonly LX.RecommendHomeSectionId[],
  sectionId: LX.RecommendHomeSectionId,
  direction: -1 | 1,
): LX.RecommendHomeSectionId[] => {
  const nextOrder = normalizeRecommendHomeSectionOrder(order)
  const index = nextOrder.indexOf(sectionId)
  const targetIndex = index + direction

  if (index < 0 || targetIndex < 0 || targetIndex >= nextOrder.length) return nextOrder

  const targetSectionId = nextOrder[targetIndex]
  nextOrder[targetIndex] = sectionId
  nextOrder[index] = targetSectionId

  return nextOrder
}
