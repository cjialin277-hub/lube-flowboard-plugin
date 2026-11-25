import { getLang } from "../i18n";

export const CHARACTER_GENDERS = [
  { key: "male", label: "Male", labelZh: "男", tag: "male" },
  { key: "female", label: "Female", labelZh: "女", tag: "female" },
] as const;

export const CHARACTER_COUNTRIES = [
  { key: "cn", label: "Chinese", labelZh: "中国", tag: "Chinese" },
  { key: "kr", label: "Korean", labelZh: "韩国", tag: "Korean" },
  { key: "jp", label: "Japanese", labelZh: "日本", tag: "Japanese" },
  { key: "us", label: "American", labelZh: "欧美/美国", tag: "American" },
  { key: "fr", label: "French", labelZh: "法国", tag: "French" },
  { key: "vn", label: "Vietnamese", labelZh: "越南", tag: "Vietnamese" },
  { key: "th", label: "Thai", labelZh: "泰国", tag: "Thai" },
] as const;

export const CHARACTER_VIBES = [
  {
    key: "dramatic_realism",
    label: "Live-Action Realism",
    labelZh: "电影写实剧感",
    tokens: [
      "Realman live-action 35mm cinema still, natural skin pores, subtle skin grain and authentic fine lines without beauty-filter smoothing",
      "natural unstyled collarbone and understated everyday home/work wardrobe texture",
      "calm grounded expression with present eye focus and natural relaxed lips",
      "soft neutral key light for accurate facial geometry across downstream video shots",
    ],
  },
  {
    key: "period_drama",
    label: "Family / Heritage Drama",
    labelZh: "年代质感剧感",
    tokens: [
      "Photorealistic narrative drama casting portrait, lived-in natural skin tone, organic hair strands and fine wool or cotton fabric weave",
      "restrained dignified expression with quiet emotional weight and steady eye contact",
      "balanced neutral studio key light without dramatic shadows obscuring either cheek or eye",
    ],
  },
  {
    key: "clean",
    label: "Clean Girl",
    labelZh: "清透自然",
    tokens: [
      "Clean Girl makeup styling, fresh dewy skin with sheer skin-tint coverage, healthy natural radiance, peachy cream blush on the cheek apples",
      "brushed-up laminated brows with clear brow gel finish, minimal eye makeup, glossy plump lips with lip-oil sheen",
      "slicked-back low bun or polished sleek hair, simple modern minimalist outfit, delicate gold hoop earrings",
      "relaxed friendly expression with a gentle subtle smile, soft natural gaze, soft natural daylight, airy bright tone, clean minimalist backdrop",
    ],
  },
  {
    key: "douyin",
    label: "Douyin",
    labelZh: "精致剧感",
    tokens: [
      "Douyin makeup styling, porcelain-smooth flawless complexion, glossy ethereal skin with subtle pearl glow",
      "shimmery glittery eyeshadow with light-catching pearl highlights, defined aegyo sal under-eye accent, individual cluster false lashes",
      "blurred-edge gradient lip in soft berry or muted red tone with diffused outline, delicate styled hair with face-framing strands, refined feminine outfit",
      "soft alluring expression with a composed sultry gaze, soft beauty lighting with subtle ethereal glow, clean pale studio backdrop, dreamy atmosphere",
    ],
  },
  {
    key: "oldmoney",
    label: "Old Money",
    labelZh: "豪门老钱风",
    tokens: [
      "Old Money makeup styling, polished neutral palette in earth tones (taupe, nude, soft coral), matte refined skin finish",
      "softly contoured eyes with warm matte brown shadow, groomed defined brows, classic red or elegant nude-pink lip",
      "polished sleek hair, timeless tailored outfit, understated gold or pearl jewelry",
      "composed dignified expression with a calm refined gaze, soft directional studio lighting, warm neutral backdrop, timeless heritage atmosphere",
    ],
  },
  {
    key: "coldgirl",
    label: "Cold Girl",
    labelZh: "清冷高智感",
    tokens: [
      "Cool-tone makeup styling, ash-pink, mauve and cool grey-brown palette, matte velvety skin finish",
      "cool-toned smoky eye, ash-pink blush, soft mauve lip, subtle high-point highlight on cheekbones, brow bone and cupid's bow",
      "sleek modern hair, edgy contemporary outfit, minimalist silver accessories",
      "cool composed expression with a confident detached gaze, cool-toned cinematic lighting, muted soft blue-grey backdrop, modern moody atmosphere",
    ],
  },
  {
    key: "kpop",
    label: "K-Pop",
    labelZh: "韩剧偶像感",
    tokens: [
      "K-pop idol styling, glossy plump lips, soft sculpted contour, glittery inner-corner highlight, dewy skin",
      "glossy hair with face-framing layers, trendy stylish outfit, delicate accessories",
      "soft confident expression, gentle closed-lip smile",
      "soft beauty lighting, clean studio glow, smooth pastel backdrop",
    ],
  },
  {
    key: "casual",
    label: "Casual",
    labelZh: "日常真实感",
    tokens: [
      "minimal natural styling, fresh clear skin, soft tinted lips",
      "relaxed natural hair, simple everyday outfit",
      "warm friendly soft smile, gentle natural gaze",
      "soft natural daylight, airy bright tone, clean light backdrop",
    ],
  },
] as const;

export type GenderKey = (typeof CHARACTER_GENDERS)[number]["key"];
export type CountryKey = (typeof CHARACTER_COUNTRIES)[number]["key"];
export type VibeKey = (typeof CHARACTER_VIBES)[number]["key"];

export function countryLabel(key: string | undefined): string | null {
  if (!key) return null;
  const found = CHARACTER_COUNTRIES.find((c) => c.key === key);
  if (!found) return null;
  return getLang() === "zh" ? found.labelZh : found.label;
}

export function vibeLabel(key: string | undefined): string | null {
  if (!key) return null;
  const found = CHARACTER_VIBES.find((v) => v.key === key);
  if (!found) return null;
  return getLang() === "zh" ? found.labelZh : found.label;
}
