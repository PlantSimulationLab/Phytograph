import { useState, useEffect } from 'react';
import { X, Sprout, ChevronDown, Loader2 } from 'lucide-react';
import { getAvailablePlantModels, PlantGenerationRequest, PlantCanopyRequest } from '../utils/backendApi';
import { DebouncedNumberInput } from './DebouncedNumberInput';

// A single plant or a regularly spaced canopy. The viewer branches on `mode`.
export type PlantGenerationPayload =
  | { mode: 'single'; request: PlantGenerationRequest }
  | { mode: 'canopy'; request: PlantCanopyRequest };

interface PlantGenerationPopupProps {
  isOpen: boolean;
  onClose: () => void;
  onGenerate: (payload: PlantGenerationPayload) => void;
  isGenerating: boolean;
  // Live build progress (0-1) and phase message while isGenerating; null before a build.
  progress?: number | null;
  progressMessage?: string;
  // Cancel an in-flight build (aborts the SSE stream).
  onCancelGenerate?: () => void;
}

// Known plant categories for better organization
const PLANT_CATEGORIES: Record<string, string[]> = {
  'Trees': ['almond', 'apple', 'apple_fruitingwall', 'easternredbud', 'olive', 'pistachio', 'walnut'],
  'Vines': ['bougainvillea', 'grapevine_VSP', 'grapevine_Wye', 'grapevine_GDC', 'grapevine_geneva_double_curtain', 'grapevine_vertical_shoot_positioned', 'grapevine_sprawl', 'grapevine_unilateral_cordon'],
  'Cereals': ['maize', 'rice', 'sorghum', 'wheat'],
  'Vegetables': ['asparagus', 'bean', 'butterlettuce', 'capsicum', 'cherrytomato', 'cowpea', 'soybean', 'strawberry', 'sugarbeet', 'tomato'],
  'Weeds': ['bindweed', 'cheeseweed', 'groundcherryweed', 'puncturevine'],
};

export function PlantGenerationPopup({ isOpen, onClose, onGenerate, isGenerating, progress, progressMessage, onCancelGenerate }: PlantGenerationPopupProps) {
  const [availableModels, setAvailableModels] = useState<string[]>([]);
  const [isLoadingModels, setIsLoadingModels] = useState(false);
  const [showAdvanced, setShowAdvanced] = useState(false);

  // Form state
  const [plantType, setPlantType] = useState('bean');
  const [age, setAge] = useState(30);
  const [positionX, setPositionX] = useState(0);
  const [positionY, setPositionY] = useState(0);
  const [positionZ, setPositionZ] = useState(0);
  const [randomSeed, setRandomSeed] = useState<number | undefined>(undefined);
  const [useRandomSeed, setUseRandomSeed] = useState(false);

  // Canopy state
  const [isCanopy, setIsCanopy] = useState(false);
  const [spacingX, setSpacingX] = useState(0.5);
  const [spacingY, setSpacingY] = useState(0.5);
  const [countX, setCountX] = useState(3);
  const [countY, setCountY] = useState(3);
  const [germinationRate, setGerminationRate] = useState(1.0);

  // Load available models when popup opens
  useEffect(() => {
    if (isOpen && availableModels.length === 0) {
      setIsLoadingModels(true);
      getAvailablePlantModels()
        .then((response) => {
          if (response.success && response.models) {
            setAvailableModels(response.models);
          }
        })
        .catch((error) => {
          console.error('Failed to load plant models:', error);
        })
        .finally(() => {
          setIsLoadingModels(false);
        });
    }
  }, [isOpen, availableModels.length]);

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();

    const seed = useRandomSeed && randomSeed !== undefined ? randomSeed : undefined;

    if (isCanopy) {
      const request: PlantCanopyRequest = {
        plant_type: plantType,
        age: age,
        center_x: positionX,
        center_y: positionY,
        center_z: positionZ,
        spacing_x: spacingX,
        spacing_y: spacingY,
        count_x: countX,
        count_y: countY,
        germination_rate: germinationRate,
      };
      if (seed !== undefined) request.random_seed = seed;
      onGenerate({ mode: 'canopy', request });
      return;
    }

    const request: PlantGenerationRequest = {
      plant_type: plantType,
      age: age,
      position_x: positionX,
      position_y: positionY,
      position_z: positionZ,
    };
    if (seed !== undefined) request.random_seed = seed;
    onGenerate({ mode: 'single', request });
  };

  // Organize models into categories
  const getModelsByCategory = () => {
    const categorized: Record<string, string[]> = {};
    const uncategorized: string[] = [];

    for (const model of availableModels) {
      let found = false;
      for (const [category, models] of Object.entries(PLANT_CATEGORIES)) {
        if (models.includes(model)) {
          if (!categorized[category]) {
            categorized[category] = [];
          }
          categorized[category].push(model);
          found = true;
          break;
        }
      }
      if (!found) {
        uncategorized.push(model);
      }
    }

    if (uncategorized.length > 0) {
      categorized['Other'] = [...(categorized['Other'] || []), ...uncategorized];
    }

    return categorized;
  };

  if (!isOpen) return null;

  const categorizedModels = getModelsByCategory();

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center">
      {/* Backdrop */}
      <div
        className="absolute inset-0 bg-black/60 backdrop-blur-sm"
        onClick={onClose}
      />

      {/* Modal */}
      <div data-testid="plant-generation-popup" className="relative bg-neutral-800 rounded-xl shadow-2xl border border-neutral-700 w-full max-w-md mx-4 overflow-hidden">
        {/* Header */}
        <div className="flex items-center justify-between px-4 py-3 border-b border-neutral-700 bg-neutral-800/90">
          <div className="flex items-center gap-2">
            <Sprout className="w-5 h-5 text-neutral-400" />
            <h2 className="text-lg font-semibold text-white">Generate Plant Model</h2>
          </div>
          <button
            onClick={onClose}
            className="p-1 rounded hover:bg-neutral-700 transition-colors"
            disabled={isGenerating}
          >
            <X className="w-5 h-5 text-neutral-400" />
          </button>
        </div>

        {/* Form */}
        <form onSubmit={handleSubmit} className="p-4 space-y-4">
          {/* Plant Type */}
          <div>
            <label className="block text-sm font-medium text-neutral-300 mb-1.5">
              Species
            </label>
            {isLoadingModels ? (
              <div className="flex items-center gap-2 text-neutral-400 text-sm">
                <Loader2 className="w-4 h-4 animate-spin" />
                Loading models...
              </div>
            ) : (
              <select
                data-testid="plant-species-select"
                value={plantType}
                onChange={(e) => setPlantType(e.target.value)}
                className="w-full px-3 py-2 bg-neutral-700 border border-neutral-600 rounded-lg text-white text-sm focus:outline-none focus:ring-2 focus:ring-green-500/50 focus:border-green-500"
                disabled={isGenerating}
              >
                {Object.entries(categorizedModels).map(([category, models]) => (
                  <optgroup key={category} label={category}>
                    {models.map((model) => (
                      <option key={model} value={model}>
                        {model.replace(/_/g, ' ').replace(/\b\w/g, c => c.toUpperCase())}
                      </option>
                    ))}
                  </optgroup>
                ))}
              </select>
            )}
          </div>

          {/* Canopy toggle */}
          <div className="flex items-center gap-2">
            <input
              data-testid="plant-canopy-toggle"
              type="checkbox"
              id="generateCanopy"
              checked={isCanopy}
              onChange={(e) => setIsCanopy(e.target.checked)}
              className="w-4 h-4 rounded border-neutral-600 bg-neutral-700 accent-green-600 focus:ring-green-500/50"
              disabled={isGenerating}
            />
            <label htmlFor="generateCanopy" className="text-sm font-medium text-neutral-300">
              Generate as canopy (grid of plants)
            </label>
          </div>

          {/* Age */}
          <div>
            <label className="block text-sm font-medium text-neutral-300 mb-1.5">
              Age (days)
            </label>
            <DebouncedNumberInput
              data-testid="plant-age-input"
              value={age}
              onCommit={setAge}
              min={0}
              step="any"
              debounceMs={0}
              className="w-full px-3 py-2 bg-neutral-700 border border-neutral-600 rounded-lg text-white text-sm focus:outline-none focus:ring-2 focus:ring-green-500/50 focus:border-green-500"
              disabled={isGenerating}
            />
            <p className="text-xs text-neutral-500 mt-1">Growth stage of the plant in days</p>
          </div>

          {/* Position / Canopy center */}
          <div>
            <label className="block text-sm font-medium text-neutral-300 mb-1.5">
              {isCanopy ? 'Canopy center (m)' : 'Position (m)'}
            </label>
            <div className="grid grid-cols-3 gap-2">
              <div>
                <label className="block text-xs text-neutral-500 mb-1">X</label>
                <DebouncedNumberInput
                  data-testid="plant-position-x"
                  value={positionX}
                  onCommit={setPositionX}
                  step={0.1}
                  debounceMs={0}
                  className="w-full px-3 py-2 bg-neutral-700 border border-neutral-600 rounded-lg text-white text-sm focus:outline-none focus:ring-2 focus:ring-green-500/50 focus:border-green-500"
                  disabled={isGenerating}
                />
              </div>
              <div>
                <label className="block text-xs text-neutral-500 mb-1">Y</label>
                <DebouncedNumberInput
                  data-testid="plant-position-y"
                  value={positionY}
                  onCommit={setPositionY}
                  step={0.1}
                  debounceMs={0}
                  className="w-full px-3 py-2 bg-neutral-700 border border-neutral-600 rounded-lg text-white text-sm focus:outline-none focus:ring-2 focus:ring-green-500/50 focus:border-green-500"
                  disabled={isGenerating}
                />
              </div>
              <div>
                <label className="block text-xs text-neutral-500 mb-1">Z</label>
                <DebouncedNumberInput
                  data-testid="plant-position-z"
                  value={positionZ}
                  onCommit={setPositionZ}
                  step={0.1}
                  debounceMs={0}
                  className="w-full px-3 py-2 bg-neutral-700 border border-neutral-600 rounded-lg text-white text-sm focus:outline-none focus:ring-2 focus:ring-green-500/50 focus:border-green-500"
                  disabled={isGenerating}
                />
              </div>
            </div>
          </div>

          {/* Canopy spacing + count */}
          {isCanopy && (
            <>
              <div>
                <label className="block text-sm font-medium text-neutral-300 mb-1.5">
                  Spacing (m)
                </label>
                <div className="grid grid-cols-2 gap-2">
                  <div>
                    <label className="block text-xs text-neutral-500 mb-1">X</label>
                    <DebouncedNumberInput
                      data-testid="canopy-spacing-x"
                      value={spacingX}
                      onCommit={setSpacingX}
                      min={0}
                      step={0.1}
                      debounceMs={0}
                      className="w-full px-3 py-2 bg-neutral-700 border border-neutral-600 rounded-lg text-white text-sm focus:outline-none focus:ring-2 focus:ring-green-500/50 focus:border-green-500"
                      disabled={isGenerating}
                    />
                  </div>
                  <div>
                    <label className="block text-xs text-neutral-500 mb-1">Y</label>
                    <DebouncedNumberInput
                      data-testid="canopy-spacing-y"
                      value={spacingY}
                      onCommit={setSpacingY}
                      min={0}
                      step={0.1}
                      debounceMs={0}
                      className="w-full px-3 py-2 bg-neutral-700 border border-neutral-600 rounded-lg text-white text-sm focus:outline-none focus:ring-2 focus:ring-green-500/50 focus:border-green-500"
                      disabled={isGenerating}
                    />
                  </div>
                </div>
              </div>

              <div>
                <label className="block text-sm font-medium text-neutral-300 mb-1.5">
                  Count (plants)
                </label>
                <div className="grid grid-cols-2 gap-2">
                  <div>
                    <label className="block text-xs text-neutral-500 mb-1">Columns (X)</label>
                    <DebouncedNumberInput
                      data-testid="canopy-count-x"
                      value={countX}
                      onCommit={setCountX}
                      parse={(s) => Math.round(parseFloat(s))}
                      min={1}
                      step={1}
                      debounceMs={0}
                      className="w-full px-3 py-2 bg-neutral-700 border border-neutral-600 rounded-lg text-white text-sm focus:outline-none focus:ring-2 focus:ring-green-500/50 focus:border-green-500"
                      disabled={isGenerating}
                    />
                  </div>
                  <div>
                    <label className="block text-xs text-neutral-500 mb-1">Rows (Y)</label>
                    <DebouncedNumberInput
                      data-testid="canopy-count-y"
                      value={countY}
                      onCommit={setCountY}
                      parse={(s) => Math.round(parseFloat(s))}
                      min={1}
                      step={1}
                      debounceMs={0}
                      className="w-full px-3 py-2 bg-neutral-700 border border-neutral-600 rounded-lg text-white text-sm focus:outline-none focus:ring-2 focus:ring-green-500/50 focus:border-green-500"
                      disabled={isGenerating}
                    />
                  </div>
                </div>
                <p className="text-xs text-neutral-500 mt-1">
                  {countX} × {countY} = {countX * countY} plants
                </p>
              </div>
            </>
          )}

          {/* Advanced Options Accordion */}
          <div className="border border-neutral-600 rounded-lg overflow-hidden">
            <button
              type="button"
              onClick={() => setShowAdvanced(!showAdvanced)}
              className="w-full flex items-center justify-between px-3 py-2 bg-neutral-700/50 hover:bg-neutral-700 transition-colors"
            >
              <span className="text-sm font-medium text-neutral-300">Advanced Options</span>
              <ChevronDown
                className={`w-4 h-4 text-neutral-400 transition-transform duration-200 ${showAdvanced ? 'rotate-180' : ''}`}
              />
            </button>

            {showAdvanced && (
              <div className="p-3 space-y-3 bg-neutral-800/50">
                {/* Random Seed */}
                <div>
                  <div className="flex items-center gap-2 mb-1.5">
                    <input
                      type="checkbox"
                      id="useRandomSeed"
                      checked={useRandomSeed}
                      onChange={(e) => setUseRandomSeed(e.target.checked)}
                      className="w-4 h-4 rounded border-neutral-600 bg-neutral-700 accent-neutral-500 focus:ring-neutral-500/50"
                      disabled={isGenerating}
                    />
                    <label htmlFor="useRandomSeed" className="text-sm font-medium text-neutral-300">
                      Use Random Seed
                    </label>
                  </div>
                  {useRandomSeed && (
                    <input
                      // type="text" + inputMode numeric (not type="number" bound to
                      // a parsed value): an empty field clears the seed to undefined,
                      // and a non-numeric keystroke is dropped without wedging a
                      // literal "NaN" into the field (parseInt('-') is NaN, and
                      // NaN ?? '' would render "NaN").
                      type="text"
                      inputMode="numeric"
                      value={randomSeed ?? ''}
                      onChange={(e) => {
                        const raw = e.target.value.trim();
                        if (raw === '') { setRandomSeed(undefined); return; }
                        const n = parseInt(raw, 10);
                        if (Number.isFinite(n)) setRandomSeed(n);
                      }}
                      placeholder="Enter seed value"
                      className="w-full px-3 py-2 bg-neutral-700 border border-neutral-600 rounded-lg text-white text-sm focus:outline-none focus:ring-2 focus:ring-green-500/50 focus:border-green-500"
                      disabled={isGenerating}
                    />
                  )}
                  <p className="text-xs text-neutral-500 mt-1">
                    Set a seed for reproducible plant generation
                  </p>
                </div>

                {/* Germination rate (canopy only) */}
                {isCanopy && (
                  <div>
                    <label className="block text-sm font-medium text-neutral-300 mb-1.5">
                      Germination rate
                    </label>
                    <DebouncedNumberInput
                      data-testid="canopy-germination-rate"
                      value={germinationRate}
                      onCommit={setGerminationRate}
                      min={0}
                      max={1}
                      step={0.05}
                      debounceMs={0}
                      className="w-full px-3 py-2 bg-neutral-700 border border-neutral-600 rounded-lg text-white text-sm focus:outline-none focus:ring-2 focus:ring-green-500/50 focus:border-green-500"
                      disabled={isGenerating}
                    />
                    <p className="text-xs text-neutral-500 mt-1">
                      Probability (0–1) each grid position is filled. 1.0 fills every position.
                    </p>
                  </div>
                )}
              </div>
            )}
          </div>

          {/* Progress bar while building, otherwise the submit button. */}
          {isGenerating ? (
            <div className="space-y-2 pt-1" data-testid="plant-generate-progress">
              <div className="flex justify-between text-xs text-neutral-400">
                <span>{progressMessage || 'Preparing...'}</span>
                <span data-testid="plant-generate-percent">
                  {progress != null && progress > 0 ? `${Math.round(progress * 100)}%` : ''}
                </span>
              </div>
              <div className="w-full h-2 bg-neutral-900 rounded-full overflow-hidden">
                <div
                  className="h-full bg-green-500 rounded-full transition-all duration-300 ease-out"
                  style={{ width: `${Math.max((progress ?? 0) * 100, 2)}%` }}
                />
              </div>
              {onCancelGenerate && (
                <button
                  type="button"
                  data-testid="plant-generate-cancel"
                  onClick={onCancelGenerate}
                  className="w-full flex items-center justify-center gap-2 px-4 py-2 bg-neutral-700 hover:bg-neutral-600 rounded-lg text-neutral-200 text-sm font-medium transition-colors"
                >
                  <X className="w-4 h-4" />
                  Cancel
                </button>
              )}
            </div>
          ) : (
            <button
              data-testid="plant-generate-button"
              type="submit"
              disabled={isLoadingModels}
              className="w-full flex items-center justify-center gap-2 px-4 py-2.5 bg-green-600 hover:bg-green-500 disabled:bg-neutral-600 disabled:cursor-not-allowed rounded-lg text-white font-medium transition-colors"
            >
              <Sprout className="w-4 h-4" />
              {isCanopy ? 'Generate Canopy' : 'Generate Plant'}
            </button>
          )}
        </form>
      </div>
    </div>
  );
}
