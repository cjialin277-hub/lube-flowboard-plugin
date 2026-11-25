import { useReactFlow } from "@xyflow/react";
import { useBoardStore } from "../store/board";
import type { NodeType } from "../store/board";
import { useLang } from "../i18n";
import { NodeTypeIcon } from "./NodeTypeIcon";

interface Chip {
  type: NodeType;
  labelEn: string;
  labelZh: string;
  tipZh: string;
}

const CHIPS: Chip[] = [
  { type: "character", labelEn: "Character", labelZh: "角色锚点", tipZh: "创建固定演员五官的角色参考卡" },
  { type: "image", labelEn: "Image", labelZh: "分镜画面", tipZh: "结合角色与场景生成单张或多景别电影剧照" },
  { type: "Storyboard", labelEn: "Storyboard", labelZh: "故事板", tipZh: "一键生成多格连续剧情分镜板" },
  { type: "video", labelEn: "Video", labelZh: "动态视频", tipZh: "将上游分镜图转化为动态运镜视频" },
  { type: "visual_asset", labelEn: "Visual asset", labelZh: "道具/场景", tipZh: "上传或生成关键道具、服装或空镜场景参考" },
  { type: "prompt", labelEn: "Prompt", labelZh: "导演提示词", tipZh: "可复用的光影色调与导演风格指令卡" },
  { type: "note", labelEn: "Note", labelZh: "便签", tipZh: "仅在画布展示的场记备注便签" },
];

export function AddNodePalette() {
  const { screenToFlowPosition } = useReactFlow();
  const addNodeOfType = useBoardStore((s) => s.addNodeOfType);
  const { isZh, t } = useLang();

  function handleAdd(type: NodeType) {
    const position = screenToFlowPosition({
      x: window.innerWidth / 2,
      y: window.innerHeight / 2,
    });
    addNodeOfType(type, position);
  }

  return (
    <div className="add-node-palette" aria-label={t("添加节点", "Add node")}>
      <span className="add-node-plus" aria-hidden="true">+</span>
      {CHIPS.map((chip) => {
        const label = isZh ? chip.labelZh : chip.labelEn;
        return (
          <button
            key={chip.type}
            className="add-node-chip"
            data-node-type={chip.type}
            aria-label={isZh ? `添加${chip.labelZh}节点` : `Add ${chip.labelEn} node`}
            title={isZh ? chip.tipZh : `Add ${chip.labelEn}`}
            onClick={() => handleAdd(chip.type)}
          >
            <span className="add-node-chip__dot" aria-hidden="true" />
            <NodeTypeIcon type={chip.type} size={13} className="add-node-chip__svg" />
            <span>{label}</span>
          </button>
        );
      })}
    </div>
  );
}
