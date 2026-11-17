'use strict';
/**
 * Learning roadmap from a skill gap. Pure function.
 *
 * Priority = weight × (1 − coverage), highest first. For each missing skill we chain the
 * catalogue resources that teach levels above what the student already has, until the
 * required level is reached, then lay the phases out one after another on a weekly timeline.
 */

/**
 * @param requirements [{skillId, skillName, requiredLevel, weight}]
 * @param owned        {skillId: level}
 * @param resources    [{skill_id, title, provider, url, level, est_hours}]
 */
function buildRoadmap({ requirements, owned, resources, hoursPerWeek = 6 }) {
  const gaps = requirements
    .map((r) => {
      const have = owned[r.skillId] || 0;
      return { ...r, have, coverage: Math.min(have, r.requiredLevel) / r.requiredLevel };
    })
    .filter((g) => g.have < g.requiredLevel)
    .sort((a, b) => b.weight * (1 - b.coverage) - a.weight * (1 - a.coverage));

  let week = 0;
  let totalHours = 0;
  const phases = gaps.map((g, i) => {
    const candidates = resources.filter((r) => r.skill_id === g.skillId && r.level > g.have).sort((a, b) => a.level - b.level);
    const picked = [];
    for (const r of candidates) {
      picked.push(r);
      if (r.level >= g.requiredLevel) break;
    }
    const reached = picked.length ? Math.max(...picked.map((r) => r.level)) : g.have;
    const catalogHours = picked.reduce((s, r) => s + (r.est_hours || 0), 0);
    const hours = catalogHours || 10 * (g.requiredLevel - g.have);        // no catalogue entry → practice estimate
    const weeks = Math.max(1, Math.ceil(hours / hoursPerWeek));
    const phase = {
      priority: i + 1,
      skillId: g.skillId,
      skill: g.skillName,
      fromLevel: g.have,
      toLevel: Math.min(g.requiredLevel, Math.max(reached, g.have)),
      requiredLevel: g.requiredLevel,
      fullyCovered: reached >= g.requiredLevel,
      hours,
      startWeek: week + 1,
      endWeek: week + weeks,
      resources: picked.map((r) => ({ title: r.title, provider: r.provider, url: r.url, level: r.level, hours: r.est_hours })),
      note: picked.length ? null : 'No catalogue course yet — build a small project to practise this skill.',
    };
    week += weeks;
    totalHours += hours;
    return phase;
  });

  return { phases, totalWeeks: week, totalHours, hoursPerWeek };
}

module.exports = { buildRoadmap };
