import { useState, useEffect, useCallback, useRef } from 'react';
import { X, Dna, Loader2, ChevronDown, ChevronRight, RotateCcw, Download, Upload } from 'lucide-react';
import {
  parsePlantMorphParameters,
  PlantMorphRequest,
  PlantMorphShoot,
  DistributionParam,
} from '../utils/backendApi';
import { DebouncedNumberInput } from './DebouncedNumberInput';

interface MorphPopupProps {
  isOpen: boolean;
  onClose: () => void;
  onMorph: (request: PlantMorphRequest) => void;
  isMorphing: boolean;
  plantType: string;
  plantAge: number;
  heliosXml: string;
}

// Deep clone helper
function deepClone<T>(obj: T): T {
  return JSON.parse(JSON.stringify(obj));
}

// ── Distribution param → XML mapping ──────────────────────────────────────
interface ParamMapping {
  xmlTargets: { key: string; section: 'internode' | 'petiole' | 'leaf' }[];
  label: string;
  group: 'Internode' | 'Petiole' | 'Leaf';
}

const DIST_PARAM_MAPPING: Record<string, ParamMapping> = {
  internode_length_max: {
    label: 'Internode Length',
    group: 'Internode',
    xmlTargets: [
      { key: 'internode_length', section: 'internode' },
      { key: 'internode_length_max', section: 'internode' },
    ],
  },
  insertion_angle_tip: {
    label: 'Insertion Angle',
    group: 'Internode',
    xmlTargets: [
      { key: 'internode_pitch', section: 'internode' },
    ],
  },
  girth_area_factor: {
    label: 'Girth Factor',
    group: 'Internode',
    xmlTargets: [
      { key: 'internode_radius', section: 'internode' },
    ],
  },
  gravitropic_curvature: {
    label: 'Gravitropic Curvature',
    group: 'Internode',
    xmlTargets: [
      { key: 'curvature_perturbations', section: 'internode' },
    ],
  },
  tortuosity: {
    label: 'Tortuosity',
    group: 'Internode',
    xmlTargets: [
      { key: 'yaw_perturbations', section: 'internode' },
    ],
  },
};

interface GeometryScaleConfig {
  label: string;
  xmlTargets: { key: string; section: 'internode' | 'petiole' | 'leaf' }[];
}

const GEOMETRY_SCALES: Record<string, GeometryScaleConfig> = {
  leaf_scale: {
    label: 'Leaf Scale',
    xmlTargets: [
      { key: 'leaf_scale', section: 'leaf' },
      { key: 'current_leaf_scale_factor', section: 'petiole' },
      { key: 'leaflet_scale', section: 'petiole' },
    ],
  },
  petiole_length: {
    label: 'Petiole Length',
    xmlTargets: [
      { key: 'petiole_length', section: 'petiole' },
    ],
  },
  petiole_radius: {
    label: 'Petiole Radius',
    xmlTargets: [
      { key: 'petiole_radius', section: 'petiole' },
    ],
  },
  internode_radius: {
    label: 'Internode Radius',
    xmlTargets: [
      { key: 'internode_radius', section: 'internode' },
    ],
  },
};

const READONLY_PARAMS = new Set([
  'max_nodes', 'max_nodes_per_season', 'phyllochron_min',
  'elongation_rate_max', 'vegetative_bud_break_probability_min',
  'vegetative_bud_break_probability_decay_rate', 'vegetative_bud_break_time',
  'flower_bud_break_probability', 'max_terminal_floral_buds',
  'fruit_set_probability', 'flowers_require_dormancy',
  'insertion_angle_decay_rate', 'base_roll', 'base_yaw',
]);

const PARAM_LABELS: Record<string, string> = {
  internode_length_max: 'Internode Length',
  insertion_angle_tip: 'Insertion Angle',
  insertion_angle_decay_rate: 'Angle Decay',
  girth_area_factor: 'Girth Factor',
  gravitropic_curvature: 'Curvature',
  tortuosity: 'Tortuosity',
  max_nodes: 'Max Nodes',
  max_nodes_per_season: 'Nodes/Season',
  phyllochron_min: 'Min Phyllochron',
  elongation_rate_max: 'Max Elong. Rate',
  vegetative_bud_break_probability_min: 'Bud Break Prob.',
  vegetative_bud_break_probability_decay_rate: 'Bud Decay',
  vegetative_bud_break_time: 'Bud Break Time',
  flower_bud_break_probability: 'Flower Prob.',
  max_terminal_floral_buds: 'Max Buds',
  fruit_set_probability: 'Fruit Prob.',
  flowers_require_dormancy: 'Req. Dormancy',
  base_roll: 'Base Roll',
  base_yaw: 'Base Yaw',
  internode_radius: 'Internode Radius',
};

function getLabel(key: string): string {
  return PARAM_LABELS[key] || key.replace(/_/g, ' ').replace(/\b\w/g, c => c.toUpperCase());
}

function isDistributionParam(val: unknown): val is DistributionParam {
  return (
    typeof val === 'object' &&
    val !== null &&
    'distribution' in val &&
    'parameters' in val &&
    Array.isArray((val as DistributionParam).parameters)
  );
}

function getDistValue(dp: DistributionParam): number {
  if (dp.distribution === 'constant') return dp.parameters[0] ?? 0;
  if (dp.distribution === 'uniform') return (dp.parameters[0] + dp.parameters[1]) / 2;
  if (dp.distribution === 'normal') return dp.parameters[0] ?? 0;
  return dp.parameters[0] ?? 0;
}

function computeScaleFactor(newParam: DistributionParam, oldParam: DistributionParam): number {
  const oldVal = getDistValue(oldParam);
  const newVal = getDistValue(newParam);
  if (Math.abs(oldVal) < 1e-9) return 1;
  return newVal / oldVal;
}

// ── Collapsible section ───────────────────────────────────────────────────
function Section({
  title,
  children,
  defaultOpen = false,
  badge,
}: {
  title: string;
  children: React.ReactNode;
  defaultOpen?: boolean;
  badge?: string;
}) {
  const [isOpen, setIsOpen] = useState(defaultOpen);

  return (
    <div className="border border-neutral-700 rounded-lg overflow-hidden mb-1.5">
      <button
        type="button"
        onClick={() => setIsOpen(!isOpen)}
        className="w-full flex items-center justify-between px-2 py-1.5 bg-neutral-700/50 hover:bg-neutral-700 transition-colors"
      >
        <span className="text-[11px] font-medium text-neutral-300">
          {title}
          {badge && <span className="text-neutral-500 ml-1 text-[10px]">({badge})</span>}
        </span>
        {isOpen ? (
          <ChevronDown className="w-3 h-3 text-neutral-400" />
        ) : (
          <ChevronRight className="w-3 h-3 text-neutral-400" />
        )}
      </button>
      {isOpen && <div className="px-2 py-1.5">{children}</div>}
    </div>
  );
}

// ── Distribution parameter row ────────────────────────────────────────────
function DistributionParamRow({
  paramKey,
  param,
  defaultParam,
  onChange,
}: {
  paramKey: string;
  param: DistributionParam;
  defaultParam: DistributionParam;
  onChange: (updated: DistributionParam) => void;
}) {
  const scaleFactor = computeScaleFactor(param, defaultParam);
  const isModified = Math.abs(scaleFactor - 1.0) > 0.001;

  // Commit a finite numeric value into parameters[index]. The text fields use
  // DebouncedNumberInput (which only emits finite numbers and owns its own text
  // draft, so a half-typed "-" / "" survives); the sliders parse their string
  // value before calling this.
  const commitParam = (index: number, numVal: number) => {
    if (!Number.isFinite(numVal)) return;
    const newParams = [...param.parameters];
    newParams[index] = numVal;
    onChange({ ...param, parameters: newParams });
  };

  const currentValue = getDistValue(param);
  const defaultValue = getDistValue(defaultParam);
  const absDefault = Math.abs(defaultValue);
  const step = absDefault < 0.01 ? 0.001 : absDefault < 1 ? 0.005 : absDefault < 10 ? 0.1 : 1;
  const rangeMax = Math.max(absDefault * 3, 0.01);
  const rangeMin = defaultValue < 0 ? defaultValue * 3 : 0;

  return (
    <div className="py-1">
      <div className="flex items-center justify-between mb-0.5">
        <div className="flex items-center gap-1">
          <label className={`text-[10px] ${isModified ? 'text-amber-400 font-medium' : 'text-neutral-400'}`}>
            {getLabel(paramKey)}
          </label>
          <span className="text-[8px] px-1 py-0 rounded bg-neutral-700 text-neutral-500">
            {param.distribution}
          </span>
        </div>
        <div className="flex items-center gap-1">
          {isModified && (
            <span className="text-[9px] text-amber-400 font-mono">
              {scaleFactor.toFixed(2)}x
            </span>
          )}
          {param.distribution === 'constant' ? (
            <DebouncedNumberInput
              value={param.parameters[0]}
              onCommit={(n) => commitParam(0, n)}
              step={step}
              debounceMs={0}
              className={`w-20 px-1 py-0.5 text-[10px] rounded border text-right ${
                isModified
                  ? 'bg-amber-900/30 border-amber-600/50 text-amber-300'
                  : 'bg-neutral-700 border-neutral-600 text-neutral-300'
              } focus:outline-none focus:ring-1 focus:ring-amber-500/50`}
            />
          ) : (
            <div className="flex items-center gap-0.5">
              <DebouncedNumberInput
                value={param.parameters[0]}
                onCommit={(n) => commitParam(0, n)}
                step={step}
                debounceMs={0}
                className={`w-16 px-1 py-0.5 text-[10px] rounded border text-right ${
                  isModified
                    ? 'bg-amber-900/30 border-amber-600/50 text-amber-300'
                    : 'bg-neutral-700 border-neutral-600 text-neutral-300'
                } focus:outline-none focus:ring-1 focus:ring-amber-500/50`}
              />
              <span className="text-neutral-500 text-[9px]">-</span>
              <DebouncedNumberInput
                value={param.parameters[1]}
                onCommit={(n) => commitParam(1, n)}
                step={step}
                debounceMs={0}
                className={`w-16 px-1 py-0.5 text-[10px] rounded border text-right ${
                  isModified
                    ? 'bg-amber-900/30 border-amber-600/50 text-amber-300'
                    : 'bg-neutral-700 border-neutral-600 text-neutral-300'
                } focus:outline-none focus:ring-1 focus:ring-amber-500/50`}
              />
            </div>
          )}
        </div>
      </div>
      {param.distribution === 'constant' && (
        <input
          type="range"
          value={currentValue}
          onChange={(e) => commitParam(0, parseFloat(e.target.value))}
          min={rangeMin}
          max={rangeMax}
          step={step}
          className="w-full h-1 bg-neutral-600 rounded-lg appearance-none cursor-pointer slider-amber"
        />
      )}
    </div>
  );
}

// ── Geometry scale slider row ─────────────────────────────────────────────
function GeometryScaleRow({
  label,
  value,
  onChange,
}: {
  label: string;
  value: number;
  onChange: (val: number) => void;
}) {
  const isModified = Math.abs(value - 1.0) > 0.001;

  return (
    <div className="py-1">
      <div className="flex items-center justify-between mb-0.5">
        <label className={`text-[10px] ${isModified ? 'text-amber-400 font-medium' : 'text-neutral-400'}`}>
          {label}
        </label>
        <div className="flex items-center gap-1">
          {isModified && (
            <span className="text-[9px] text-amber-400 font-mono">
              {value.toFixed(2)}x
            </span>
          )}
          <DebouncedNumberInput
            value={value}
            onCommit={onChange}
            step={0.01}
            min={0.1}
            max={3.0}
            debounceMs={0}
            className={`w-16 px-1 py-0.5 text-[10px] rounded border text-right ${
              isModified
                ? 'bg-amber-900/30 border-amber-600/50 text-amber-300'
                : 'bg-neutral-700 border-neutral-600 text-neutral-300'
            } focus:outline-none focus:ring-1 focus:ring-amber-500/50`}
          />
        </div>
      </div>
      <input
        type="range"
        value={value}
        onChange={(e) => onChange(parseFloat(e.target.value))}
        min={0.1}
        max={3.0}
        step={0.01}
        className="w-full h-1 bg-neutral-600 rounded-lg appearance-none cursor-pointer slider-amber"
      />
    </div>
  );
}

// ── Scale XML value helpers ───────────────────────────────────────────────
function scaleXmlValue(val: string, factor: number): string {
  if (val.includes(';')) {
    return val.split(';').map(part => {
      const trimmed = part.trim();
      const num = parseFloat(trimmed);
      if (isNaN(num) || Math.abs(num) < 1e-9) return trimmed;
      return String(num * factor);
    }).join(';');
  }
  const num = parseFloat(val);
  if (isNaN(num)) return val;
  if (Math.abs(num) < 1e-9) return val;
  return String(num * factor);
}

function applyScaleToShoots(
  defaultShoots: PlantMorphShoot[],
  shootTypeLabel: string,
  targets: { key: string; section: 'internode' | 'petiole' | 'leaf' }[],
  factor: number,
  result: PlantMorphShoot[],
) {
  for (let shootIdx = 0; shootIdx < result.length; shootIdx++) {
    const shoot = result[shootIdx];
    if (shoot.shoot_type_label !== shootTypeLabel) continue;
    for (let phyIdx = 0; phyIdx < shoot.phytomers.length; phyIdx++) {
      const phytomer = shoot.phytomers[phyIdx];
      const defaultPhytomer = defaultShoots[shootIdx]?.phytomers[phyIdx];
      if (!defaultPhytomer) continue;

      for (const target of targets) {
        if (target.section === 'internode') {
          const defaultVal = defaultPhytomer.internode[target.key];
          if (defaultVal !== undefined) {
            phytomer.internode[target.key] = scaleXmlValue(defaultVal, factor);
          }
        } else if (target.section === 'petiole') {
          for (let pi = 0; pi < phytomer.petioles.length; pi++) {
            const defaultPetiole = defaultPhytomer.petioles[pi];
            if (!defaultPetiole) continue;
            if (target.key in defaultPetiole && typeof defaultPetiole[target.key] === 'string') {
              phytomer.petioles[pi][target.key] = scaleXmlValue(defaultPetiole[target.key] as string, factor);
            }
          }
        } else if (target.section === 'leaf') {
          for (let pi = 0; pi < phytomer.petioles.length; pi++) {
            const defaultPetiole = defaultPhytomer.petioles[pi];
            if (!defaultPetiole) continue;
            for (let li = 0; li < phytomer.petioles[pi].leaves.length; li++) {
              const defaultLeaf = defaultPetiole.leaves[li];
              if (!defaultLeaf) continue;
              if (target.key in defaultLeaf) {
                phytomer.petioles[pi].leaves[li][target.key] = scaleXmlValue(defaultLeaf[target.key], factor);
              }
            }
          }
        }
      }
    }
  }
}

// ── Main component ────────────────────────────────────────────────────────
export function MorphPopup({
  isOpen,
  onClose,
  onMorph,
  isMorphing,
  plantType,
  plantAge,
  heliosXml,
}: MorphPopupProps) {
  const [distributionParams, setDistributionParams] = useState<Record<string, Record<string, DistributionParam>>>({});
  const [defaultDistributionParams, setDefaultDistributionParams] = useState<Record<string, Record<string, DistributionParam>>>({});
  const [geometryScales, setGeometryScales] = useState<Record<string, Record<string, number>>>({});
  const [defaultShoots, setDefaultShoots] = useState<PlantMorphShoot[]>([]);
  const [parsedAge, setParsedAge] = useState(0);
  const [basePosition, setBasePosition] = useState('0 0 0');
  const [rawDistParams, setRawDistParams] = useState<Record<string, Record<string, unknown>>>({});
  const [activeShootType, setActiveShootType] = useState('');
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);

  // Track whether we've loaded for this open session so we don't re-parse
  // when heliosXml changes from a regrow (settings should persist).
  const hasLoadedRef = useRef(false);

  // Parse XML only on first open — settings persist across regrows
  useEffect(() => {
    if (!isOpen) {
      hasLoadedRef.current = false;
      return;
    }
    if (hasLoadedRef.current || !heliosXml) return;
    hasLoadedRef.current = true;

    setIsLoading(true);
    setError(null);
    parsePlantMorphParameters(heliosXml, plantType)
      .then((response) => {
        if (response.success) {
          setDefaultShoots(deepClone(response.shoots));
          setParsedAge(response.plant_age);
          setBasePosition(response.base_position);

          const distParams: Record<string, Record<string, DistributionParam>> = {};
          const rawDist: Record<string, Record<string, unknown>> = {};
          const geoScales: Record<string, Record<string, number>> = {};

          if (response.distribution_params) {
            for (const [label, params] of Object.entries(response.distribution_params)) {
              distParams[label] = {};
              rawDist[label] = {};
              geoScales[label] = {};

              for (const paramKey of Object.keys(DIST_PARAM_MAPPING)) {
                const val = params[paramKey];
                if (isDistributionParam(val)) {
                  distParams[label][paramKey] = deepClone(val);
                }
              }

              for (const scaleKey of Object.keys(GEOMETRY_SCALES)) {
                geoScales[label][scaleKey] = 1.0;
              }

              for (const [pk, pv] of Object.entries(params)) {
                rawDist[label][pk] = pv;
              }
            }
          }

          setDistributionParams(distParams);
          setDefaultDistributionParams(deepClone(distParams));
          setGeometryScales(geoScales);
          setRawDistParams(rawDist);

          const labels = [...new Set(response.shoots.map((s: PlantMorphShoot) => s.shoot_type_label))];
          setActiveShootType(labels[0] || '');
        } else {
          setError(response.error || 'Failed to parse plant XML');
        }
      })
      .catch((err) => {
        setError(err.message || 'Failed to parse plant structure');
        hasLoadedRef.current = false; // allow retry
      })
      .finally(() => {
        setIsLoading(false);
      });
  }, [isOpen, heliosXml, plantType]);

  const shootTypeLabels = [...new Set(defaultShoots.map(s => s.shoot_type_label))];

  const updateDistParam = useCallback(
    (shootType: string, paramKey: string, updated: DistributionParam) => {
      setDistributionParams(prev => ({
        ...prev,
        [shootType]: {
          ...(prev[shootType] || {}),
          [paramKey]: updated,
        },
      }));
    },
    []
  );

  const updateGeoScale = useCallback(
    (shootType: string, scaleKey: string, value: number) => {
      setGeometryScales(prev => ({
        ...prev,
        [shootType]: {
          ...(prev[shootType] || {}),
          [scaleKey]: value,
        },
      }));
    },
    []
  );

  const handleReset = useCallback(() => {
    setDistributionParams(deepClone(defaultDistributionParams));
    const resetScales: Record<string, Record<string, number>> = {};
    for (const label of Object.keys(geometryScales)) {
      resetScales[label] = {};
      for (const scaleKey of Object.keys(GEOMETRY_SCALES)) {
        resetScales[label][scaleKey] = 1.0;
      }
    }
    setGeometryScales(resetScales);
  }, [defaultDistributionParams, geometryScales]);

  const handleExport = useCallback(() => {
    const data = {
      plant_type: plantType,
      distribution_params: distributionParams,
      geometry_scales: geometryScales,
    };
    const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `${plantType}_morph_params.json`;
    a.click();
    URL.revokeObjectURL(url);
  }, [plantType, distributionParams, geometryScales]);

  const handleImport = useCallback(
    (e: React.ChangeEvent<HTMLInputElement>) => {
      const file = e.target.files?.[0];
      if (!file) return;
      const reader = new FileReader();
      reader.onload = (ev) => {
        try {
          const data = JSON.parse(ev.target?.result as string);
          if (data.distribution_params) {
            setDistributionParams(data.distribution_params);
          }
          if (data.geometry_scales) {
            setGeometryScales(data.geometry_scales);
          }
        } catch {
          setError('Failed to parse imported JSON');
        }
      };
      reader.readAsText(file);
      e.target.value = '';
    },
    []
  );

  const handleSubmit = useCallback(() => {
    const modifiedShoots = deepClone(defaultShoots);

    for (const shootType of Object.keys(distributionParams)) {
      const currentParams = distributionParams[shootType] || {};
      const defaults = defaultDistributionParams[shootType] || {};

      for (const [paramKey, currentParam] of Object.entries(currentParams)) {
        const defaultParam = defaults[paramKey];
        if (!defaultParam) continue;

        const scaleFactor = computeScaleFactor(currentParam, defaultParam);
        if (Math.abs(scaleFactor - 1.0) < 0.001) continue;

        const mapping = DIST_PARAM_MAPPING[paramKey];
        if (!mapping) continue;

        applyScaleToShoots(defaultShoots, shootType, mapping.xmlTargets, scaleFactor, modifiedShoots);
      }
    }

    for (const shootType of Object.keys(geometryScales)) {
      const scales = geometryScales[shootType] || {};
      for (const [scaleKey, multiplier] of Object.entries(scales)) {
        if (Math.abs(multiplier - 1.0) < 0.001) continue;
        const config = GEOMETRY_SCALES[scaleKey];
        if (!config) continue;

        applyScaleToShoots(defaultShoots, shootType, config.xmlTargets, multiplier, modifiedShoots);
      }
    }

    const buildXml = (): string => {
      let xml = '<?xml version="1.0" encoding="UTF-8"?>\n<helios>\n';
      xml += `\t<plant_instance ID="0">\n`;
      xml += `\t\t<base_position> ${basePosition} </base_position>\n`;
      xml += `\t\t<plant_age> ${parsedAge} </plant_age>\n`;

      for (const shoot of modifiedShoots) {
        xml += `\t\t<shoot ID="${shoot.shoot_id}">\n`;
        xml += `\t\t\t<shoot_type_label> ${shoot.shoot_type_label} </shoot_type_label>\n`;
        xml += `\t\t\t<parent_shoot_ID> ${shoot.parent_shoot_id} </parent_shoot_ID>\n`;
        xml += `\t\t\t<parent_node_index> ${shoot.parent_node_index} </parent_node_index>\n`;
        xml += `\t\t\t<parent_petiole_index> ${shoot.parent_petiole_index} </parent_petiole_index>\n`;
        xml += `\t\t\t<base_rotation> ${shoot.base_rotation} </base_rotation>\n`;

        for (const phytomer of shoot.phytomers) {
          xml += `\t\t\t<phytomer>\n`;
          xml += `\t\t\t\t<internode>\n`;

          for (const [key, val] of Object.entries(phytomer.internode)) {
            xml += `\t\t\t\t\t<${key}>${val}</${key}>\n`;
          }

          for (const petiole of phytomer.petioles) {
            xml += `\t\t\t\t\t<petiole>\n`;
            for (const [key, val] of Object.entries(petiole)) {
              if (key === 'leaves') {
                for (const leaf of petiole.leaves) {
                  xml += `\t\t\t\t\t\t<leaf>\n`;
                  for (const [lk, lv] of Object.entries(leaf)) {
                    xml += `\t\t\t\t\t\t\t<${lk}>${lv}</${lk}>\n`;
                  }
                  xml += `\t\t\t\t\t\t</leaf>\n`;
                }
              } else {
                xml += `\t\t\t\t\t\t<${key}>${val}</${key}>\n`;
              }
            }
            xml += `\t\t\t\t\t</petiole>\n`;
          }

          xml += `\t\t\t\t</internode>\n`;
          xml += `\t\t\t</phytomer>\n`;
        }

        xml += `\t\t</shoot>\n`;
      }

      xml += `\t</plant_instance>\n</helios>`;
      return xml;
    };

    onMorph({
      plant_type: plantType,
      helios_xml: buildXml(),
    });
  }, [plantType, parsedAge, basePosition, defaultShoots, distributionParams, defaultDistributionParams, geometryScales, onMorph]);

  if (!isOpen) return null;

  const speciesLabel = plantType.replace(/_/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase());

  const activeDistParams = distributionParams[activeShootType] || {};
  const activeDefaultDistParams = defaultDistributionParams[activeShootType] || {};
  const activeGeoScales = geometryScales[activeShootType] || {};
  const activeRawParams = rawDistParams[activeShootType] || {};

  const editableByGroup: Record<string, string[]> = {};
  for (const [paramKey] of Object.entries(activeDistParams)) {
    const mapping = DIST_PARAM_MAPPING[paramKey];
    if (!mapping) continue;
    if (!editableByGroup[mapping.group]) editableByGroup[mapping.group] = [];
    editableByGroup[mapping.group].push(paramKey);
  }

  const readonlyParams: [string, unknown][] = [];
  for (const [pk, pv] of Object.entries(activeRawParams)) {
    if (pk in DIST_PARAM_MAPPING) continue;
    if (READONLY_PARAMS.has(pk)) readonlyParams.push([pk, pv]);
  }

  const hasDistParams = Object.keys(activeDistParams).length > 0;

  return (
    <div className="absolute top-4 right-[280px] bg-neutral-800/95 backdrop-blur-sm rounded-lg shadow-lg w-80 z-40 flex flex-col max-h-[calc(100vh-120px)]">
      {/* Header */}
      <div className="flex items-center justify-between px-3 py-2 border-b border-neutral-700 shrink-0">
        <div className="flex items-center gap-1.5">
          <Dna className="w-3.5 h-3.5 text-amber-400" />
          <span className="text-xs font-medium text-neutral-300">
            Morph: {speciesLabel} ({plantAge}d)
          </span>
        </div>
        <button
          onClick={onClose}
          className="text-neutral-500 hover:text-neutral-300"
        >
          <X className="w-3.5 h-3.5" />
        </button>
      </div>

      {/* Loading */}
      {isLoading && (
        <div className="flex items-center justify-center py-6">
          <Loader2 className="w-4 h-4 text-amber-400 animate-spin mr-1.5" />
          <span className="text-[10px] text-neutral-400">Parsing plant...</span>
        </div>
      )}

      {/* Error */}
      {error && (
        <div className="px-3 py-4 text-center">
          <p className="text-red-400 text-[10px]">{error}</p>
        </div>
      )}

      {/* Content */}
      {!isLoading && !error && defaultShoots.length > 0 && (
        <>
          {/* Shoot type tabs (if more than one type) */}
          {shootTypeLabels.length > 1 && (
            <div className="flex gap-0.5 px-2 pt-1.5 pb-1 border-b border-neutral-700 shrink-0 overflow-x-auto">
              {shootTypeLabels.map((label) => (
                <button
                  key={label}
                  onClick={() => setActiveShootType(label)}
                  className={`px-2 py-1 text-[10px] font-medium rounded transition-colors whitespace-nowrap ${
                    activeShootType === label
                      ? 'bg-neutral-700 text-amber-400'
                      : 'text-neutral-500 hover:text-neutral-300 hover:bg-neutral-700/50'
                  }`}
                >
                  {label}
                </button>
              ))}
            </div>
          )}

          {/* Scrollable body */}
          <div className="overflow-y-auto flex-1 p-2 space-y-1">
            {/* Geometry Parameters */}
            {hasDistParams && (
              <Section title="Geometry Parameters" defaultOpen={true}>
                {Object.entries(editableByGroup).map(([group, paramKeys]) => (
                  <div key={group} className="mb-1.5">
                    <span className="text-[9px] text-neutral-500 font-medium uppercase tracking-wider">{group}</span>
                    {paramKeys.map(paramKey => {
                      const param = activeDistParams[paramKey];
                      const defaultParam = activeDefaultDistParams[paramKey];
                      if (!param || !defaultParam) return null;
                      return (
                        <DistributionParamRow
                          key={paramKey}
                          paramKey={paramKey}
                          param={param}
                          defaultParam={defaultParam}
                          onChange={(updated) => updateDistParam(activeShootType, paramKey, updated)}
                        />
                      );
                    })}
                  </div>
                ))}
              </Section>
            )}

            {/* Geometry Scale */}
            <Section title="Geometry Scale" defaultOpen={true}>
              {Object.entries(GEOMETRY_SCALES).map(([scaleKey, config]) => (
                <GeometryScaleRow
                  key={scaleKey}
                  label={config.label}
                  value={activeGeoScales[scaleKey] ?? 1.0}
                  onChange={(val) => updateGeoScale(activeShootType, scaleKey, val)}
                />
              ))}
            </Section>

            {/* Growth & Structural (read-only) */}
            {readonlyParams.length > 0 && (
              <Section title="Growth & Structural" defaultOpen={false} badge="read-only">
                <div className="space-y-0.5">
                  {readonlyParams.map(([pk, pv]) => (
                    <div key={pk} className="flex items-center justify-between py-0.5">
                      <span className="text-[10px] text-neutral-500">{getLabel(pk)}</span>
                      <span className="text-[10px] text-neutral-400 font-mono">
                        {typeof pv === 'boolean'
                          ? (
                            <span className={`px-1 py-0 rounded text-[9px] ${pv ? 'bg-green-900/30 text-green-400' : 'bg-neutral-700 text-neutral-500'}`}>
                              {pv ? 'true' : 'false'}
                            </span>
                          )
                          : isDistributionParam(pv)
                            ? `${pv.distribution}(${pv.parameters.map(p => p.toFixed(2)).join(', ')})`
                            : String(pv)
                        }
                      </span>
                    </div>
                  ))}
                </div>
              </Section>
            )}
          </div>

          {/* Footer */}
          <div className="px-2 py-2 border-t border-neutral-700 shrink-0 space-y-1.5">
            {/* Utility buttons */}
            <div className="flex items-center gap-1">
              <button
                type="button"
                onClick={handleReset}
                className="flex items-center gap-1 px-2 py-1 text-[10px] font-medium text-neutral-300 bg-neutral-700 hover:bg-neutral-600 rounded transition-colors"
                disabled={isMorphing}
                title="Reset to defaults"
              >
                <RotateCcw className="w-3 h-3" />
                Reset
              </button>
              <button
                type="button"
                onClick={handleExport}
                className="flex items-center gap-1 px-2 py-1 text-[10px] font-medium text-neutral-300 bg-neutral-700 hover:bg-neutral-600 rounded transition-colors"
                disabled={isMorphing}
                title="Export parameters"
              >
                <Download className="w-3 h-3" />
              </button>
              <button
                type="button"
                onClick={() => fileInputRef.current?.click()}
                className="flex items-center gap-1 px-2 py-1 text-[10px] font-medium text-neutral-300 bg-neutral-700 hover:bg-neutral-600 rounded transition-colors"
                disabled={isMorphing}
                title="Import parameters"
              >
                <Upload className="w-3 h-3" />
              </button>
              <input
                ref={fileInputRef}
                type="file"
                accept=".json"
                onChange={handleImport}
                className="hidden"
              />
            </div>

            {/* Regrow button */}
            <button
              type="button"
              onClick={handleSubmit}
              disabled={isMorphing || isLoading}
              className="w-full flex items-center justify-center gap-1.5 px-3 py-1.5 bg-amber-600 hover:bg-amber-500 disabled:bg-neutral-600 disabled:cursor-not-allowed rounded text-[11px] text-white font-medium transition-colors"
            >
              {isMorphing ? (
                <>
                  <Loader2 className="w-3.5 h-3.5 animate-spin" />
                  Regrowing...
                </>
              ) : (
                <>
                  <Dna className="w-3.5 h-3.5" />
                  Regrow
                </>
              )}
            </button>
          </div>
        </>
      )}
    </div>
  );
}
