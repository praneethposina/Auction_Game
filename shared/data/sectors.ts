// Sectors drive three things: sector bonuses (owning several companies in one sector),
// running costs (costRatio reflects real-world margin/opex intensity), and market events.

export type SectorId =
  | 'ai'
  | 'semis'
  | 'chipmaking'
  | 'software'
  | 'internet'
  | 'retail'
  | 'hardware'
  | 'media'
  | 'gaming'
  | 'fintech'
  | 'banking'
  | 'cyber'
  | 'auto'
  | 'energy'
  | 'pharma'
  | 'staples'
  | 'luxury'
  | 'travel'
  | 'aerospace'
  | 'industrial'
  | 'telecom'
  | 'itservices';

export interface SectorDef {
  id: SectorId;
  name: string;
  short: string;
  icon: string;
  color: string;
  /** Running cost per round as a share of the tier's expected turnover. Low = fat margins. */
  costRatio: number;
  why: string;
}

export const SECTORS: Record<SectorId, SectorDef> = {
  ai: {
    id: 'ai',
    name: 'AI Labs',
    short: 'AI',
    icon: '🧠',
    color: '#a78bfa',
    costRatio: 0.55,
    why: 'Frontier labs burn enormous sums on compute and talent.',
  },
  semis: {
    id: 'semis',
    name: 'Chip Designers',
    short: 'Chips',
    icon: '🔲',
    color: '#34d399',
    costRatio: 0.32,
    why: 'Fabless designers enjoy some of the fattest margins in tech.',
  },
  chipmaking: {
    id: 'chipmaking',
    name: 'Foundries & Chip Tools',
    short: 'Fabs',
    icon: '🏭',
    color: '#10b981',
    costRatio: 0.45,
    why: 'Fabs and lithography tools need huge, ongoing capital spending.',
  },
  software: {
    id: 'software',
    name: 'Cloud & Software',
    short: 'Software',
    icon: '☁️',
    color: '#60a5fa',
    costRatio: 0.25,
    why: 'Software scales with almost no marginal cost.',
  },
  internet: {
    id: 'internet',
    name: 'Internet & Social',
    short: 'Internet',
    icon: '🌐',
    color: '#38bdf8',
    costRatio: 0.3,
    why: 'Ad-funded platforms are high margin but spend heavily on data centers.',
  },
  retail: {
    id: 'retail',
    name: 'E-commerce & Retail',
    short: 'Retail',
    icon: '🛒',
    color: '#fbbf24',
    costRatio: 0.6,
    why: 'Retail runs on thin margins: inventory, logistics and wages.',
  },
  hardware: {
    id: 'hardware',
    name: 'Consumer Hardware',
    short: 'Hardware',
    icon: '📱',
    color: '#94a3b8',
    costRatio: 0.45,
    why: 'Devices carry real component and manufacturing costs.',
  },
  media: {
    id: 'media',
    name: 'Media & Streaming',
    short: 'Media',
    icon: '🎬',
    color: '#f472b6',
    costRatio: 0.5,
    why: 'Content budgets eat a large share of subscription revenue.',
  },
  gaming: {
    id: 'gaming',
    name: 'Gaming',
    short: 'Gaming',
    icon: '🎮',
    color: '#c084fc',
    costRatio: 0.4,
    why: 'Blockbuster games are expensive to build but print money when they hit.',
  },
  fintech: {
    id: 'fintech',
    name: 'Fintech & Payments',
    short: 'Fintech',
    icon: '💳',
    color: '#22d3ee',
    costRatio: 0.3,
    why: 'Payment networks take a cut of every transaction at very low cost.',
  },
  banking: {
    id: 'banking',
    name: 'Banks & Finance',
    short: 'Banks',
    icon: '🏦',
    color: '#2dd4bf',
    costRatio: 0.4,
    why: 'Banks earn the spread between lending and deposit rates.',
  },
  cyber: {
    id: 'cyber',
    name: 'Cybersecurity',
    short: 'Cyber',
    icon: '🛡️',
    color: '#f87171',
    costRatio: 0.35,
    why: 'Security software is sticky, subscription-based and high margin.',
  },
  auto: {
    id: 'auto',
    name: 'Autos & EVs',
    short: 'Autos',
    icon: '🚗',
    color: '#fb923c',
    costRatio: 0.55,
    why: 'Car making is capital-heavy with thin margins outside luxury.',
  },
  energy: {
    id: 'energy',
    name: 'Energy & Power',
    short: 'Energy',
    icon: '⚡',
    color: '#facc15',
    costRatio: 0.5,
    why: 'Drilling, refining and power plants need constant investment.',
  },
  pharma: {
    id: 'pharma',
    name: 'Pharma & Healthcare',
    short: 'Pharma',
    icon: '💊',
    color: '#4ade80',
    costRatio: 0.4,
    why: 'Blockbuster drugs are lucrative but R&D pipelines are costly.',
  },
  staples: {
    id: 'staples',
    name: 'Food & Beverage',
    short: 'Staples',
    icon: '🥤',
    color: '#fca5a5',
    costRatio: 0.45,
    why: 'Steady demand, but ingredients and distribution cost real money.',
  },
  luxury: {
    id: 'luxury',
    name: 'Luxury & Apparel',
    short: 'Luxury',
    icon: '👜',
    color: '#e879f9',
    costRatio: 0.35,
    why: 'Brand power lets luxury houses charge far above cost.',
  },
  travel: {
    id: 'travel',
    name: 'Travel & Mobility',
    short: 'Travel',
    icon: '✈️',
    color: '#67e8f9',
    costRatio: 0.55,
    why: 'Fuel, staff and fleets make travel a high fixed-cost business.',
  },
  aerospace: {
    id: 'aerospace',
    name: 'Aerospace & Defense',
    short: 'Aero',
    icon: '🚀',
    color: '#818cf8',
    costRatio: 0.5,
    why: 'Long, expensive programs backed by multi-year contracts.',
  },
  industrial: {
    id: 'industrial',
    name: 'Industrials & Logistics',
    short: 'Industrial',
    icon: '🚚',
    color: '#a3a3a3',
    costRatio: 0.5,
    why: 'Machines, trucks and ships: steady but capital intensive.',
  },
  telecom: {
    id: 'telecom',
    name: 'Telecom & Networking',
    short: 'Telecom',
    icon: '📡',
    color: '#5eead4',
    costRatio: 0.45,
    why: 'Networks are expensive to build and carry heavy debt.',
  },
  itservices: {
    id: 'itservices',
    name: 'IT Services',
    short: 'IT Svcs',
    icon: '🧑‍💻',
    color: '#93c5fd',
    costRatio: 0.45,
    why: 'Consulting margins are capped by salaries for large workforces.',
  },
};

export const SECTOR_IDS = Object.keys(SECTORS) as SectorId[];

/** Bonus applied to every company in a sector when you own at least `need` of that sector. */
export const SECTOR_BONUS_TIERS: { need: number; bonus: number }[] = [
  { need: 2, bonus: 0.1 },
  { need: 3, bonus: 0.2 },
  { need: 4, bonus: 0.35 },
];
