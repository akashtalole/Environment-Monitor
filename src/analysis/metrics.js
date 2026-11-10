// The impact metrics we extract from EIA / EMP reports, executive summaries, hearing
// orders and minutes. Both extractors (rules and Claude) produce this same shape:
//   { [key]: { value, unit, page, quote, method, docUrl } }
// "group" drives the dashboard sections and the impact sub-scores.

export const METRICS = [
  // Project
  { key: 'capacityMW', label: 'Installed capacity', unit: 'MW', type: 'number', group: 'project' },
  { key: 'storageHours', label: 'Daily generation hours', unit: 'h', type: 'number', group: 'project' },
  { key: 'projectCostCr', label: 'Project cost', unit: '₹ Cr', type: 'number', group: 'project' },
  { key: 'constructionMonths', label: 'Construction period', unit: 'months', type: 'number', group: 'project' },
  { key: 'loopType', label: 'Loop type', unit: '', type: 'string', group: 'project', hint: 'open loop / closed loop / off-stream' },
  { key: 'maxDamHeightM', label: 'Max dam height', unit: 'm', type: 'number', group: 'project' },
  { key: 'eiaConsultant', label: 'EIA consultant', unit: '', type: 'string', group: 'project' },
  { key: 'torDate', label: 'ToR granted on', unit: 'date', type: 'string', group: 'project', hint: 'YYYY-MM-DD' },

  // Land & forest
  { key: 'totalLandHa', label: 'Total land', unit: 'ha', type: 'number', group: 'land' },
  { key: 'forestLandHa', label: 'Forest land diverted', unit: 'ha', type: 'number', group: 'land' },
  { key: 'nonForestLandHa', label: 'Non-forest land', unit: 'ha', type: 'number', group: 'land' },
  { key: 'submergenceHa', label: 'Submergence area', unit: 'ha', type: 'number', group: 'land' },
  { key: 'treesFelled', label: 'Trees to be felled', unit: 'trees', type: 'number', group: 'land' },
  { key: 'muckLakhCum', label: 'Muck generated', unit: 'lakh m³', type: 'number', group: 'land' },
  { key: 'muckDisposalHa', label: 'Muck disposal area', unit: 'ha', type: 'number', group: 'land' },

  // Water
  { key: 'upperReservoirMCM', label: 'Upper reservoir gross storage', unit: 'MCM', type: 'number', group: 'water' },
  { key: 'lowerReservoirMCM', label: 'Lower reservoir gross storage', unit: 'MCM', type: 'number', group: 'water' },
  { key: 'initialFillMCM', label: 'Initial / one-time filling', unit: 'MCM', type: 'number', group: 'water' },
  { key: 'annualMakeupMCM', label: 'Annual make-up water', unit: 'MCM/yr', type: 'number', group: 'water' },
  { key: 'waterSource', label: 'Water source', unit: '', type: 'string', group: 'water' },

  // Biodiversity & protected areas
  { key: 'nearestProtectedArea', label: 'Nearest protected area', unit: '', type: 'string', group: 'biodiversity' },
  { key: 'protectedAreaKm', label: 'Distance to protected area', unit: 'km', type: 'number', group: 'biodiversity' },
  { key: 'westernGhatsESA', label: 'In Western Ghats ESA (draft)', unit: '', type: 'boolean', group: 'biodiversity' },
  { key: 'insideESZ', label: 'Inside notified Eco-Sensitive Zone', unit: '', type: 'boolean', group: 'biodiversity' },
  { key: 'scheduleISpecies', label: 'Schedule-I species reported', unit: 'species', type: 'number', group: 'biodiversity' },
  { key: 'threatenedSpecies', label: 'IUCN threatened species (CR/EN/VU)', unit: 'species', type: 'number', group: 'biodiversity' },
  { key: 'plantSpecies', label: 'Plant species recorded', unit: 'species', type: 'number', group: 'biodiversity' },

  // Social
  { key: 'studyAreaVillages', label: 'Villages in study area', unit: 'villages', type: 'number', group: 'social' },
  { key: 'affectedVillages', label: 'Directly affected villages', unit: 'villages', type: 'number', group: 'social' },
  { key: 'affectedHouseholds', label: 'Affected households', unit: 'households', type: 'number', group: 'social' },
  { key: 'affectedPopulation', label: 'Affected population', unit: 'people', type: 'number', group: 'social' },
  { key: 'displacedFamilies', label: 'Families to be displaced / PAFs', unit: 'families', type: 'number', group: 'social' },
  { key: 'tribalSharePct', label: 'Scheduled Tribe share (affected area)', unit: '%', type: 'number', group: 'social' },
  { key: 'rrPlanRequired', label: 'R&R plan required', unit: '', type: 'boolean', group: 'social' },
  { key: 'heritageNearby', label: 'Heritage / tourist sites nearby', unit: '', type: 'string', group: 'social' },

  // Mitigation & budgets
  { key: 'empCapitalCr', label: 'EMP budget (capital)', unit: '₹ Cr', type: 'number', group: 'mitigation' },
  { key: 'empTotalCr', label: 'EMP budget (capital + recurring)', unit: '₹ Cr', type: 'number', group: 'mitigation' },
  { key: 'compensatoryAfforestationCr', label: 'Compensatory afforestation', unit: '₹ Cr', type: 'number', group: 'mitigation' },
  { key: 'biodiversityPlanCr', label: 'Biodiversity / wildlife plan', unit: '₹ Cr', type: 'number', group: 'mitigation' },
  { key: 'muckPlanCr', label: 'Muck disposal plan', unit: '₹ Cr', type: 'number', group: 'mitigation' },
  { key: 'monitoringCr', label: 'Environmental monitoring', unit: '₹ Cr', type: 'number', group: 'mitigation' },
  { key: 'cerCr', label: 'CER / CSR commitment', unit: '₹ Cr', type: 'number', group: 'mitigation' },
  { key: 'co2ReductionMtPerYr', label: 'Claimed CO₂ reduction', unit: 'Mt/yr', type: 'number', group: 'mitigation' },

  // Baseline environment
  { key: 'seismicZone', label: 'Seismic zone', unit: '', type: 'string', group: 'baseline' },
  { key: 'pm10MaxUgm3', label: 'Max PM10 (baseline)', unit: 'µg/m³', type: 'number', group: 'baseline' },
  { key: 'pm25MaxUgm3', label: 'Max PM2.5 (baseline)', unit: 'µg/m³', type: 'number', group: 'baseline' },
  { key: 'annualRainfallMm', label: 'Annual rainfall', unit: 'mm', type: 'number', group: 'baseline' },
];

export const METRIC_BY_KEY = Object.fromEntries(METRICS.map((m) => [m.key, m]));

export const GROUPS = {
  project: 'Project',
  land: 'Land & forest',
  water: 'Water',
  biodiversity: 'Biodiversity',
  social: 'People',
  mitigation: 'Mitigation & budgets',
  baseline: 'Baseline environment',
};

export const IMPACT_CATEGORIES = ['land', 'forest', 'biodiversity', 'water', 'air', 'noise', 'social', 'cultural', 'hydrology', 'geology', 'other'];
