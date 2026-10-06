// Existing playback tests exercise the enabled policy. Lifecycle/off behavior is
// covered with the real adapter in build-config/performance/recommendation-access.test.js.
module.exports = {
  assertRecommendationEnabled() {},
  beginRecommendationSession: async() => {},
  endRecommendationSession() {},
  hasRecommendationSession: () => true,
  isRecommendationEnabled: () => true,
  getRecommendationRevision: () => 0,
  isRecommendationRequestCurrent: () => true,
  registerRecommendationCleanup: () => () => {},
  useRecommendationPage: () => () => true,
}
