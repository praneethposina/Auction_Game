import type { SectorId } from './sectors.ts';

// Market events are drawn one per round and announced BEFORE that round's auctions,
// so players can bid with the news in mind. Effects apply to that round's payouts.
//
// demand: change to turnover (revenue side). +0.3 = +30% turnover this round.
// costs:  change to running costs (supply side / input prices). +0.2 = +20% costs.
// Company-level entries stack on top of the sector entry for that company.

export type SectorDelta = Partial<Record<SectorId, number>>;

export interface MarketEventDef {
  id: string;
  headline: string;
  icon: string;
  story: string;
  demand: SectorDelta;
  costs: SectorDelta;
  companyDemand?: Record<string, number>;
  companyCosts?: Record<string, number>;
  /** Relative draw frequency. Default 1. */
  weight?: number;
}

export const MARKET_EVENTS: MarketEventDef[] = [
  {
    id: 'rate_hike',
    headline: 'Central bank hikes rates by 75 bps',
    icon: '🏦',
    story:
      'Inflation is running hot, so borrowing gets expensive. Banks earn fatter interest margins, shoppers delay car and big-ticket purchases, and debt-heavy, capital-intensive businesses pay more to finance themselves.',
    demand: { banking: 0.25, auto: -0.15, fintech: -0.1, retail: -0.05, luxury: -0.05, travel: -0.05 },
    costs: { telecom: 0.15, chipmaking: 0.15, auto: 0.15, ai: 0.1, energy: 0.1, industrial: 0.1 },
  },
  {
    id: 'rate_cut',
    headline: 'Rate cuts are back: cheap money returns',
    icon: '💸',
    story:
      'Easier credit lifts consumer spending on cars, travel and luxury. Fintech lending and trading volumes jump, while banks see their interest margins squeezed. Capital-hungry companies refinance for less.',
    demand: { auto: 0.15, retail: 0.1, luxury: 0.1, travel: 0.1, fintech: 0.15, software: 0.05, banking: -0.1 },
    costs: { telecom: -0.1, chipmaking: -0.1, ai: -0.1, auto: -0.1 },
  },
  {
    id: 'ai_capex',
    headline: 'AI capex supercycle: hyperscalers pledge record spending',
    icon: '🧠',
    story:
      'Cloud giants pour hundreds of billions into data centers. Chip designers and fabs sell everything they can make, power and electrical-gear suppliers get new orders, and AI labs grow revenue but pay steep compute bills.',
    demand: { semis: 0.4, chipmaking: 0.25, ai: 0.3, software: 0.15, hardware: 0.1, energy: 0.1, industrial: 0.1 },
    costs: { ai: 0.25, software: 0.1 },
    companyDemand: { supermicro: 0.2, arista: 0.25, constellation: 0.2, ge_vernova: 0.15 },
  },
  {
    id: 'gpu_shortage',
    headline: 'GPU shortage: lead times stretch past a year',
    icon: '⏳',
    story:
      'Demand for AI accelerators far exceeds supply, handing chipmakers pricing power. Everyone renting compute pays more.',
    demand: { semis: 0.3, chipmaking: 0.2 },
    costs: { ai: 0.35, software: 0.15, internet: 0.1 },
    companyDemand: { nvidia: 0.15, tsmc: 0.1 },
  },
  {
    id: 'ai_bubble',
    headline: 'AI bubble wobbles: investors demand returns',
    icon: '🫧',
    story:
      'Enterprise AI pilots stall and spending gets cut. AI labs and chip suppliers see orders slow, while labs trim burn to survive.',
    demand: { ai: -0.3, semis: -0.2, chipmaking: -0.1, software: -0.1, hardware: -0.05 },
    costs: { ai: -0.1 },
    companyDemand: { supermicro: -0.15 },
  },
  {
    id: 'ai_agents_rollout',
    headline: 'Enterprises roll out AI agents at scale',
    icon: '🤖',
    story:
      'Companies finally deploy AI agents across their workflows. Software platforms and consultants cash in on implementation, and security vendors sell protection for the new attack surface.',
    demand: { software: 0.2, itservices: 0.2, ai: 0.2, cyber: 0.1 },
    costs: { itservices: -0.05 },
  },
  {
    id: 'oil_spike',
    headline: 'OPEC+ slashes output: oil hits $130',
    icon: '🛢️',
    story:
      'A supply shock sends crude soaring. Oil producers print cash; airlines and shippers get crushed by fuel bills; consumers cut back on driving and gas-guzzlers.',
    demand: { energy: 0.45, travel: -0.15, auto: -0.1 },
    costs: { travel: 0.35, industrial: 0.2, retail: 0.1, staples: 0.1, aerospace: 0.05, auto: 0.05 },
    companyDemand: { nextera: -0.3, first_solar: -0.2, constellation: -0.3, tesla: 0.15, byd: 0.15, rivian: 0.15 },
  },
  {
    id: 'oil_glut',
    headline: 'Oil glut: crude crashes to $45',
    icon: '📉',
    story:
      'Too much supply meets weak demand. Producers lose money on every barrel, while airlines, shippers and manufacturers enjoy cheap fuel.',
    demand: { energy: -0.35, travel: 0.1, auto: 0.05 },
    costs: { travel: -0.25, industrial: -0.15, retail: -0.05, staples: -0.05 },
    companyDemand: { nextera: 0.3, first_solar: 0.2, constellation: 0.35 },
  },
  {
    id: 'recession',
    headline: 'Recession hits: GDP shrinks two quarters in a row',
    icon: '🌧️',
    story:
      'Unemployment rises and budgets tighten. Discretionary spending, ad budgets and loan books suffer. Defensive businesses like groceries and medicine hold up.',
    demand: {
      luxury: -0.2,
      auto: -0.25,
      travel: -0.25,
      internet: -0.15,
      retail: -0.1,
      media: -0.1,
      banking: -0.15,
      industrial: -0.15,
      itservices: -0.1,
      software: -0.05,
      staples: 0.05,
    },
    costs: {},
    companyDemand: { costco: 0.2, walmart: 0.15, mcdonalds: 0.1 },
  },
  {
    id: 'consumer_boom',
    headline: 'Consumer spending boom',
    icon: '🛍️',
    story:
      'Wages are rising and confidence is high. People shop, travel, buy cars and splurge on luxury; payment volumes surge.',
    demand: { retail: 0.2, luxury: 0.25, travel: 0.25, auto: 0.15, media: 0.1, gaming: 0.1, internet: 0.1, fintech: 0.15 },
    costs: { retail: 0.05 },
  },
  {
    id: 'pandemic',
    headline: 'New pandemic: global lockdowns',
    icon: '🦠',
    story:
      'Everyone stays home. Streaming, gaming, e-commerce and remote-work software boom and pharma races to respond. Travel collapses and supply chains snarl.',
    demand: {
      pharma: 0.35,
      media: 0.3,
      gaming: 0.35,
      software: 0.15,
      telecom: 0.1,
      staples: 0.1,
      retail: 0.1,
      travel: -0.5,
      aerospace: -0.25,
      luxury: -0.15,
      energy: -0.2,
    },
    costs: { industrial: 0.15, hardware: 0.1 },
    companyDemand: { moderna: 0.5, pfizer: 0.35, amazon: 0.15, doordash: 0.6, netflix: 0.15, uber: 0.3 },
  },
  {
    id: 'tariffs',
    headline: 'Trade war: sweeping tariffs announced',
    icon: '🧱',
    story:
      'Import duties raise the cost of goods made abroad. Retailers, device makers and carmakers face higher input costs, and chip exports to China face retaliation.',
    demand: { semis: -0.1, chipmaking: -0.1, aerospace: -0.05, energy: -0.05 },
    costs: { retail: 0.25, hardware: 0.25, auto: 0.2, industrial: 0.15, luxury: 0.1, staples: 0.1 },
  },
  {
    id: 'export_controls',
    headline: 'Chip export controls tightened',
    icon: '🚫',
    story:
      'Advanced chips and chipmaking tools can no longer be sold to China. Western chip suppliers lose a big market, while Chinese AI labs and device makers pay up for scarce hardware.',
    demand: { semis: -0.2, chipmaking: -0.25 },
    costs: {},
    companyCosts: { deepseek: 0.3, baidu: 0.15, alibaba: 0.1, bytedance: 0.1, tencent: 0.1, xiaomi: 0.1 },
  },
  {
    id: 'chips_act',
    headline: 'Chip subsidies 2.0: governments fund new fabs',
    icon: '🏗️',
    story:
      'Governments hand out grants and tax credits for domestic chip manufacturing, cutting the cost of building fabs and lifting equipment orders.',
    demand: { chipmaking: 0.2, semis: 0.05 },
    costs: { chipmaking: -0.2 },
    companyDemand: { intel: 0.15, micron: 0.1 },
  },
  {
    id: 'memory_glut',
    headline: 'Memory chip glut: prices collapse',
    icon: '💾',
    story:
      'Memory makers built too much capacity and prices crash. PC and phone makers enjoy cheaper components.',
    demand: {},
    costs: { hardware: -0.1 },
    companyDemand: { micron: -0.35, sk_hynix: -0.35, samsung: -0.15 },
  },
  {
    id: 'antitrust',
    headline: 'Big Tech antitrust crackdown',
    icon: '⚖️',
    story:
      'Regulators force app store and ad-tech changes and hand out record fines. Platform giants lose revenue and pay lawyers.',
    demand: { internet: -0.2, software: -0.05, hardware: -0.05 },
    costs: { internet: 0.2, software: 0.05 },
    companyDemand: { alphabet: -0.1, apple: -0.1, amazon: -0.05, meta: -0.05 },
  },
  {
    id: 'privacy_law',
    headline: 'Strict new data-privacy law passes',
    icon: '🔏',
    story:
      'Tracking-based ads lose targeting power. Compliance becomes mandatory, which is great news for security vendors and consultants.',
    demand: { internet: -0.2, media: -0.05, cyber: 0.2, itservices: 0.1 },
    costs: { internet: 0.1, fintech: 0.1, banking: 0.05, software: 0.05 },
  },
  {
    id: 'ransomware',
    headline: 'Global ransomware wave',
    icon: '🏴‍☠️',
    story:
      'Hospitals, banks and retailers get hit. Security budgets explode while victims pay for cleanup and downtime.',
    demand: { cyber: 0.4, itservices: 0.1 },
    costs: { banking: 0.15, retail: 0.1, pharma: 0.1, software: 0.1, telecom: 0.1 },
  },
  {
    id: 'crypto_bull',
    headline: 'Crypto bull run: Bitcoin doubles',
    icon: '₿',
    story:
      'Retail traders pile back in. Exchanges and trading apps rake in fees, and miners buy chips and power.',
    demand: { fintech: 0.3, semis: 0.05, energy: 0.05 },
    costs: {},
    companyDemand: { coinbase: 0.4, robinhood: 0.3, block: 0.2 },
  },
  {
    id: 'crypto_winter',
    headline: 'Crypto winter: exchanges go quiet',
    icon: '🥶',
    story: 'Prices crash, trading volumes dry up and crypto-exposed fintechs feel the chill.',
    demand: { fintech: -0.15 },
    costs: {},
    companyDemand: { coinbase: -0.4, robinhood: -0.25, block: -0.2 },
  },
  {
    id: 'glp1',
    headline: 'Weight-loss drugs go mainstream',
    icon: '💉',
    story:
      'GLP-1 prescriptions soar. Their makers can’t keep up with demand, while snack and soda companies see people eat and drink less.',
    demand: { pharma: 0.15, staples: -0.15 },
    costs: {},
    companyDemand: { eli_lilly: 0.35, novo_nordisk: 0.35, mcdonalds: -0.05 },
  },
  {
    id: 'drug_price_caps',
    headline: 'Drug price caps enacted',
    icon: '📜',
    story: 'Governments negotiate down the prices of blockbuster drugs. Pharma revenue falls while insurers benefit.',
    demand: { pharma: -0.25 },
    costs: {},
    companyDemand: { unitedhealth: 0.35, intuitive_surgical: 0.2 },
  },
  {
    id: 'green_deal',
    headline: 'Clean energy subsidy package signed',
    icon: '🌱',
    story:
      'Tax credits for solar, wind, grid upgrades and EVs. Renewable builders and grid-equipment makers win, oil majors face tougher rules.',
    demand: { auto: 0.05, industrial: 0.1 },
    costs: {},
    companyDemand: {
      first_solar: 0.4,
      nextera: 0.3,
      tesla: 0.15,
      rivian: 0.15,
      ge_vernova: 0.15,
      constellation: 0.1,
      exxon: -0.1,
      chevron: -0.1,
      aramco: -0.05,
    },
  },
  {
    id: 'shipping_crisis',
    headline: 'Shipping crisis: key sea route closed',
    icon: '🚢',
    story:
      'Ships reroute around Africa, adding weeks and fuel. Freight rates spike (great for shipping lines) while importers pay more for everything.',
    demand: { industrial: 0.05 },
    costs: { retail: 0.2, hardware: 0.15, auto: 0.15, staples: 0.1, luxury: 0.05 },
    companyDemand: { maersk: 0.45 },
  },
  {
    id: 'wage_inflation',
    headline: 'Labor shortage: wage inflation wave',
    icon: '👷',
    story:
      'Workers are scarce and pay rises fast. Labor-heavy businesses see costs jump; companies that sell automation get new demand.',
    demand: { software: 0.1, ai: 0.1, industrial: 0.05 },
    costs: { retail: 0.2, travel: 0.2, staples: 0.15, industrial: 0.15, itservices: 0.15, auto: 0.1 },
  },
  {
    id: 'election_ads',
    headline: 'Election year ad blitz',
    icon: '🗳️',
    story: 'Campaigns spend billions on ads across TV, streaming and social platforms.',
    demand: { internet: 0.2, media: 0.25, telecom: 0.05 },
    costs: {},
  },
  {
    id: 'defense_surge',
    headline: 'Geopolitical tensions: defense budgets surge',
    icon: '🎖️',
    story:
      'Governments raise military spending. Defense contractors and cyber firms land big contracts; energy prices tick up and travel softens.',
    demand: { aerospace: 0.35, cyber: 0.15, energy: 0.1, travel: -0.1, luxury: -0.05 },
    costs: { industrial: 0.05 },
    companyDemand: { palantir: 0.25, anduril: 0.3 },
  },
  {
    id: 'travel_boom',
    headline: 'Revenge travel summer',
    icon: '🏖️',
    story:
      'Record passenger numbers. Airlines, hotels and booking sites sell out and order more planes, while hiring staff gets pricier.',
    demand: { travel: 0.35, aerospace: 0.15, luxury: 0.1, energy: 0.05 },
    costs: { travel: 0.1 },
  },
  {
    id: 'cocoa_coffee',
    headline: 'Cocoa and coffee prices hit record highs',
    icon: '☕',
    story: 'Bad harvests send commodity prices soaring and squeeze food and beverage margins.',
    demand: {},
    costs: { staples: 0.2 },
    companyCosts: { starbucks: 0.2, nestle: 0.15 },
  },
  {
    id: 'bank_run',
    headline: 'Regional bank run sparks credit fears',
    icon: '🏃',
    story:
      'Depositors pull money and lending freezes. Banks book losses and pay more for funding; big, trusted banks attract fleeing deposits.',
    demand: { banking: -0.2, fintech: -0.1 },
    costs: { banking: 0.2 },
    companyDemand: { jpmorgan: 0.25, berkshire: 0.15 },
  },
  {
    id: 'streaming_price_hikes',
    headline: 'Streaming price hikes stick',
    icon: '📺',
    story: 'Subscribers grumble but don’t cancel, so streaming services lift margins across the board.',
    demand: { media: 0.2, gaming: 0.05 },
    costs: {},
  },
  {
    id: 'ev_price_war',
    headline: 'EV price war breaks out',
    icon: '⚔️',
    story: 'Carmakers slash EV prices to win share. Volumes rise but profits fall across the auto sector.',
    demand: { auto: -0.15 },
    costs: { auto: 0.05 },
    companyDemand: { byd: 0.1, ferrari: 0.15 },
  },
  {
    id: 'satellite_boom',
    headline: 'Satellite internet goes mainstream',
    icon: '🛰️',
    story: 'Direct-to-phone satellite service takes off. Launch providers win; traditional carriers face new rivals.',
    demand: { aerospace: 0.1, telecom: -0.05 },
    costs: {},
    companyDemand: { spacex: 0.4, tmobile: 0.15 },
  },
  {
    id: 'china_stimulus',
    headline: 'China unleashes stimulus package',
    icon: '🐉',
    story:
      'Beijing cuts rates and hands out consumption vouchers. Chinese companies, luxury brands and commodity producers get a lift.',
    demand: { luxury: 0.15, energy: 0.05, industrial: 0.05 },
    costs: {},
    companyDemand: {
      tencent: 0.2,
      alibaba: 0.25,
      jd: 0.25,
      pdd: 0.2,
      byd: 0.2,
      xiaomi: 0.2,
      baidu: 0.15,
      netease: 0.15,
      china_mobile: 0.1,
      ant_group: 0.15,
      caterpillar: 0.1,
    },
  },
  {
    id: 'strong_dollar',
    headline: 'Dollar surges to a 20-year high',
    icon: '💵',
    story:
      'A strong dollar shrinks the value of overseas sales for US multinationals and makes US exports pricier, while foreign exporters gain an edge.',
    demand: { software: -0.05, staples: -0.05, hardware: -0.05, itservices: 0.1 },
    costs: {},
    companyDemand: {
      apple: -0.05,
      microsoft: -0.05,
      coca_cola: -0.05,
      toyota: 0.1,
      sony: 0.1,
      nintendo: 0.1,
      samsung: 0.05,
      tcs: 0.05,
      infosys: 0.05,
    },
  },
  {
    id: 'goldilocks',
    headline: 'Goldilocks economy: steady growth, low inflation',
    icon: '🌤️',
    story: 'Not too hot, not too cold. A calm quarter with a small lift almost everywhere.',
    demand: {
      ai: 0.05,
      semis: 0.05,
      software: 0.05,
      internet: 0.05,
      retail: 0.05,
      banking: 0.05,
      travel: 0.05,
      industrial: 0.05,
      luxury: 0.05,
    },
    costs: {},
    weight: 0.7,
  },
];

export const EVENT_BY_ID: Record<string, MarketEventDef> = Object.fromEntries(
  MARKET_EVENTS.map((e) => [e.id, e]),
);
