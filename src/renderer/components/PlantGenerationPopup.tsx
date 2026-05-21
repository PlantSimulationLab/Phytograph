import { useState, useEffect } from 'react';
import { X, Sprout, ChevronDown, Loader2 } from 'lucide-react';
import { getAvailablePlantModels, PlantGenerationRequest } from '../utils/backendApi';

interface PlantGenerationPopupProps {
  isOpen: boolean;
  onClose: () => void;
  onGenerate: (request: PlantGenerationRequest) => void;
  isGenerating: boolean;
}

// Known plant categories for better organization
const PLANT_CATEGORIES: Record<string, string[]> = {
  'Trees': ['almond', 'apple', 'apple_fruitingwall', 'easternredbud', 'olive', 'pistachio', 'walnut'],
  'Vines': ['bougainvillea', 'grapevine_VSP', 'grapevine_Wye', 'grapevine_GDC', 'grapevine_geneva_double_curtain', 'grapevine_vertical_shoot_positioned', 'grapevine_sprawl', 'grapevine_unilateral_cordon'],
  'Cereals': ['maize', 'rice', 'sorghum', 'wheat'],
  'Vegetables': ['asparagus', 'bean', 'butterlettuce', 'capsicum', 'cherrytomato', 'cowpea', 'soybean', 'strawberry', 'sugarbeet', 'tomato'],
  'Weeds': ['bindweed', 'cheeseweed', 'groundcherryweed', 'puncturevine'],
};

export function PlantGenerationPopup({ isOpen, onClose, onGenerate, isGenerating }: PlantGenerationPopupProps) {
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

    const request: PlantGenerationRequest = {
      plant_type: plantType,
      age: age,
      position_x: positionX,
      position_y: positionY,
      position_z: positionZ,
    };

    if (useRandomSeed && randomSeed !== undefined) {
      request.random_seed = randomSeed;
    }

    onGenerate(request);
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

          {/* Age */}
          <div>
            <label className="block text-sm font-medium text-neutral-300 mb-1.5">
              Age (days)
            </label>
            <input
              data-testid="plant-age-input"
              type="number"
              value={age}
              onChange={(e) => setAge(Math.max(0, parseFloat(e.target.value) || 0))}
              min={0}
              step="any"
              className="w-full px-3 py-2 bg-neutral-700 border border-neutral-600 rounded-lg text-white text-sm focus:outline-none focus:ring-2 focus:ring-green-500/50 focus:border-green-500"
              disabled={isGenerating}
            />
            <p className="text-xs text-neutral-500 mt-1">Growth stage of the plant in days</p>
          </div>

          {/* Position */}
          <div>
            <label className="block text-sm font-medium text-neutral-300 mb-1.5">
              Position (m)
            </label>
            <div className="grid grid-cols-3 gap-2">
              <div>
                <label className="block text-xs text-neutral-500 mb-1">X</label>
                <input
                  type="number"
                  value={positionX}
                  onChange={(e) => setPositionX(parseFloat(e.target.value) || 0)}
                  step={0.1}
                  className="w-full px-3 py-2 bg-neutral-700 border border-neutral-600 rounded-lg text-white text-sm focus:outline-none focus:ring-2 focus:ring-green-500/50 focus:border-green-500"
                  disabled={isGenerating}
                />
              </div>
              <div>
                <label className="block text-xs text-neutral-500 mb-1">Y</label>
                <input
                  type="number"
                  value={positionY}
                  onChange={(e) => setPositionY(parseFloat(e.target.value) || 0)}
                  step={0.1}
                  className="w-full px-3 py-2 bg-neutral-700 border border-neutral-600 rounded-lg text-white text-sm focus:outline-none focus:ring-2 focus:ring-green-500/50 focus:border-green-500"
                  disabled={isGenerating}
                />
              </div>
              <div>
                <label className="block text-xs text-neutral-500 mb-1">Z</label>
                <input
                  type="number"
                  value={positionZ}
                  onChange={(e) => setPositionZ(parseFloat(e.target.value) || 0)}
                  step={0.1}
                  className="w-full px-3 py-2 bg-neutral-700 border border-neutral-600 rounded-lg text-white text-sm focus:outline-none focus:ring-2 focus:ring-green-500/50 focus:border-green-500"
                  disabled={isGenerating}
                />
              </div>
            </div>
          </div>

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
                      type="number"
                      value={randomSeed ?? ''}
                      onChange={(e) => setRandomSeed(e.target.value ? parseInt(e.target.value) : undefined)}
                      placeholder="Enter seed value"
                      className="w-full px-3 py-2 bg-neutral-700 border border-neutral-600 rounded-lg text-white text-sm focus:outline-none focus:ring-2 focus:ring-green-500/50 focus:border-green-500"
                      disabled={isGenerating}
                    />
                  )}
                  <p className="text-xs text-neutral-500 mt-1">
                    Set a seed for reproducible plant generation
                  </p>
                </div>
              </div>
            )}
          </div>

          {/* Submit Button */}
          <button
            data-testid="plant-generate-button"
            type="submit"
            disabled={isGenerating || isLoadingModels}
            className="w-full flex items-center justify-center gap-2 px-4 py-2.5 bg-green-600 hover:bg-green-500 disabled:bg-neutral-600 disabled:cursor-not-allowed rounded-lg text-white font-medium transition-colors"
          >
            {isGenerating ? (
              <>
                <Loader2 className="w-4 h-4 animate-spin" />
                Generating...
              </>
            ) : (
              <>
                <Sprout className="w-4 h-4" />
                Generate Plant
              </>
            )}
          </button>
        </form>
      </div>
    </div>
  );
}
