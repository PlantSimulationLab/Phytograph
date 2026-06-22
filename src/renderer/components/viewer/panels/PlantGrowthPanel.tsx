import { ClockPlus, Play, Film, StopCircle, Loader2 } from 'lucide-react';
import { DebouncedNumberInput } from '../../DebouncedNumberInput';

type GifBackground = 'transparent' | 'black' | 'white';
type GifCameraView = 'current' | 'front' | 'side' | 'top' | 'iso';
interface GifProgress {
  current: number;
  total: number;
  phase: 'frames' | 'encoding';
}

// Presentational growth controls for a Helios plant mesh: age stepping, "go to
// age", and the growth-animation / GIF section. State and all handlers live in
// PointCloudViewer; the parent gates on `showPlantGrowthPanel && selectedMesh?.isPlant`
// and passes the selected mesh's id + age in. Regeneration itself
// (handleAdvancePlantAge) stays in the parent.
interface PlantGrowthPanelProps {
  // Current plant age in days (selectedMesh.plantAge ?? 0).
  currentAge: number;
  ageStep: number;
  targetAge: string;
  animationStartAge: string;
  animationEndAge: string;
  gifBackground: GifBackground;
  gifCameraView: GifCameraView;
  isAdvancingAge: boolean;
  isAnimating: boolean;
  isGeneratingGif: boolean;
  animationProgress: number | null;
  gifProgress: GifProgress | null;
  onClose: () => void;
  onAdvanceAge: (delta: number) => void;
  onAgeStepChange: (n: number) => void;
  onTargetAgeChange: (v: string) => void;
  onAnimationStartAgeChange: (v: string) => void;
  onAnimationEndAgeChange: (v: string) => void;
  onGifBackgroundChange: (bg: GifBackground) => void;
  onGifCameraViewChange: (view: GifCameraView) => void;
  onStartAnimation: () => void;
  onMakeGif: () => void;
  onStopAnimation: () => void;
  onStopMakeGif: () => void;
}

export function PlantGrowthPanel({
  currentAge,
  ageStep,
  targetAge,
  animationStartAge,
  animationEndAge,
  gifBackground,
  gifCameraView,
  isAdvancingAge,
  isAnimating,
  isGeneratingGif,
  animationProgress,
  gifProgress,
  onClose,
  onAdvanceAge,
  onAgeStepChange,
  onTargetAgeChange,
  onAnimationStartAgeChange,
  onAnimationEndAgeChange,
  onGifBackgroundChange,
  onGifCameraViewChange,
  onStartAnimation,
  onMakeGif,
  onStopAnimation,
  onStopMakeGif,
}: PlantGrowthPanelProps) {
  const handleGoToAge = () => {
    const target = parseFloat(targetAge);
    if (!isNaN(target) && target >= 0) {
      const delta = target - currentAge;
      if (delta !== 0) {
        onAdvanceAge(delta);
      }
    }
  };

  const cameraViews: GifCameraView[] = ['current', 'front', 'side', 'top', 'iso'];
  const cameraLabels: Record<GifCameraView, { label: string; title: string }> = {
    current: { label: 'Current', title: 'Use current camera angle' },
    front: { label: 'Front', title: 'Front view' },
    side: { label: 'Side', title: 'Side view' },
    top: { label: 'Top', title: 'Top view' },
    iso: { label: 'Iso', title: 'Isometric view' },
  };

  return (
    <div className="absolute top-4 right-[280px] bg-neutral-800/90 backdrop-blur-sm rounded-lg p-3 shadow-lg w-56">
      <div className="text-xs font-medium text-neutral-300 mb-3 flex items-center justify-between">
        <span className="flex items-center gap-2">
          <ClockPlus className="w-3 h-3 text-neutral-400" />
          Plant Growth
        </span>
        <button
          onClick={onClose}
          className="text-neutral-500 hover:text-neutral-300"
        >
          ×
        </button>
      </div>

      <div className="space-y-3">
        {/* Current Age Display */}
        <div className="text-[10px] text-neutral-400">
          Current Age: <span className="text-white font-medium">{currentAge.toFixed(0)} days</span>
        </div>

        {/* Quick Increment Buttons */}
        <div>
          <div className="text-[9px] text-neutral-500 mb-1">Quick Adjust</div>
          <div className="flex gap-1">
            <button
              onClick={() => onAdvanceAge(-1)}
              disabled={isAdvancingAge || currentAge <= 0}
              className="flex-1 px-2 py-1.5 bg-neutral-700 hover:bg-neutral-600 disabled:bg-neutral-600/50 disabled:cursor-not-allowed rounded text-[10px] text-white font-medium transition-colors"
            >
              -1
            </button>
            <button
              onClick={() => onAdvanceAge(1)}
              disabled={isAdvancingAge}
              className="flex-1 px-2 py-1.5 bg-neutral-700 hover:bg-neutral-600 disabled:bg-neutral-600/50 disabled:cursor-not-allowed rounded text-[10px] text-white font-medium transition-colors"
            >
              +1
            </button>
          </div>
        </div>

        {/* Custom Step Section */}
        <div>
          <div className="text-[9px] text-neutral-500 mb-1">Custom Step</div>
          <div className="flex gap-1">
            <button
              onClick={() => onAdvanceAge(-ageStep)}
              disabled={isAdvancingAge || currentAge - ageStep < 0}
              className="px-2 py-1.5 bg-neutral-700 hover:bg-neutral-600 disabled:bg-neutral-600/50 disabled:cursor-not-allowed rounded text-[10px] text-white font-medium transition-colors"
            >
              −
            </button>
            <DebouncedNumberInput
              value={ageStep}
              onCommit={onAgeStepChange}
              parse={(s) => Math.round(parseFloat(s))}
              min={1}
              debounceMs={0}
              className="flex-1 w-12 px-2 py-1 bg-neutral-700 border border-neutral-600 rounded text-[10px] text-white text-center focus:outline-none focus:ring-1 focus:ring-neutral-500"
              disabled={isAdvancingAge}
            />
            <button
              onClick={() => onAdvanceAge(ageStep)}
              disabled={isAdvancingAge}
              className="px-2 py-1.5 bg-neutral-700 hover:bg-neutral-600 disabled:bg-neutral-600/50 disabled:cursor-not-allowed rounded text-[10px] text-white font-medium transition-colors"
            >
              +
            </button>
          </div>
        </div>

        {/* Go To Age Section */}
        <div>
          <div className="text-[9px] text-neutral-500 mb-1">Go to Age</div>
          <div className="flex gap-1">
            <input
              type="number"
              onWheel={(e) => e.currentTarget.blur()}
              value={targetAge}
              onChange={(e) => onTargetAgeChange(e.target.value)}
              placeholder={currentAge.toFixed(0)}
              min={0}
              className="flex-1 px-2 py-1.5 bg-neutral-700 border border-neutral-600 rounded text-[10px] text-white focus:outline-none focus:ring-1 focus:ring-neutral-500"
              disabled={isAdvancingAge}
              onKeyDown={(e) => e.key === 'Enter' && handleGoToAge()}
            />
            <button
              onClick={handleGoToAge}
              disabled={isAdvancingAge || !targetAge || parseFloat(targetAge) === currentAge}
              className="px-3 py-1.5 bg-blue-600 hover:bg-blue-500 disabled:bg-neutral-600/50 disabled:cursor-not-allowed rounded text-[10px] text-white font-medium transition-colors"
            >
              Go
            </button>
          </div>
        </div>

        {/* Growth Animation Section */}
        <div className="border-t border-neutral-700 pt-3 mt-1">
          <div className="text-[9px] text-neutral-500 mb-1">Growth Animation</div>
          <div className="flex gap-1 mb-2">
            <div className="flex-1">
              <label className="text-[8px] text-neutral-500 block mb-0.5">Start</label>
              <input
                type="number"
                onWheel={(e) => e.currentTarget.blur()}
                value={animationStartAge}
                onChange={(e) => onAnimationStartAgeChange(e.target.value)}
                min={0}
                className="w-full px-2 py-1 bg-neutral-700 border border-neutral-600 rounded text-[10px] text-white focus:outline-none focus:ring-1 focus:ring-neutral-500"
                disabled={isAnimating || isAdvancingAge}
              />
            </div>
            <div className="flex-1">
              <label className="text-[8px] text-neutral-500 block mb-0.5">End</label>
              <input
                type="number"
                onWheel={(e) => e.currentTarget.blur()}
                value={animationEndAge}
                onChange={(e) => onAnimationEndAgeChange(e.target.value)}
                min={0}
                className="w-full px-2 py-1 bg-neutral-700 border border-neutral-600 rounded text-[10px] text-white focus:outline-none focus:ring-1 focus:ring-neutral-500"
                disabled={isAnimating || isAdvancingAge}
              />
            </div>
          </div>
          {/* GIF Settings Row */}
          <div className="flex gap-2 mb-2">
            <div className="flex-1">
              <label className="text-[8px] text-neutral-500 block mb-0.5">Background</label>
              <select
                value={gifBackground}
                onChange={(e) => onGifBackgroundChange(e.target.value as GifBackground)}
                className="w-full px-2 py-1 bg-neutral-700 border border-neutral-600 rounded text-[10px] text-white focus:outline-none focus:ring-1 focus:ring-neutral-500"
                disabled={isAnimating || isGeneratingGif || isAdvancingAge}
              >
                <option value="black">Black</option>
                <option value="white">White</option>
                <option value="transparent">Transparent</option>
              </select>
            </div>
          </div>
          {/* GIF Camera View */}
          <div className="mb-2">
            <label className="text-[8px] text-neutral-500 block mb-1">Camera View</label>
            <div className="flex gap-1">
              {cameraViews.map((view) => (
                <button
                  key={view}
                  onClick={() => onGifCameraViewChange(view)}
                  disabled={isAnimating || isGeneratingGif || isAdvancingAge}
                  className={`flex-1 px-2 py-1 rounded text-[9px] transition-colors ${
                    gifCameraView === view
                      ? 'bg-purple-600 text-white'
                      : 'bg-neutral-700 text-neutral-300 hover:bg-neutral-600'
                  } disabled:opacity-50`}
                  title={cameraLabels[view].title}
                >
                  {cameraLabels[view].label}
                </button>
              ))}
            </div>
          </div>
          <div className="flex gap-1">
            {!isAnimating && !isGeneratingGif ? (
              <>
                <button
                  onClick={onStartAnimation}
                  disabled={isAdvancingAge || parseInt(animationStartAge) >= parseInt(animationEndAge)}
                  className="flex-1 px-3 py-1.5 bg-green-600 hover:bg-green-500 disabled:bg-neutral-600/50 disabled:cursor-not-allowed rounded text-[10px] text-white font-medium transition-colors flex items-center justify-center gap-1"
                >
                  <Play className="w-3 h-3" />
                  Start
                </button>
                <button
                  onClick={onMakeGif}
                  disabled={isAdvancingAge || parseInt(animationStartAge) >= parseInt(animationEndAge)}
                  className="flex-1 px-3 py-1.5 bg-purple-600 hover:bg-purple-500 disabled:bg-neutral-600/50 disabled:cursor-not-allowed rounded text-[10px] text-white font-medium transition-colors flex items-center justify-center gap-1"
                >
                  <Film className="w-3 h-3" />
                  Make GIF
                </button>
              </>
            ) : isAnimating ? (
              <button
                onClick={onStopAnimation}
                className="flex-1 px-3 py-1.5 bg-red-600 hover:bg-red-500 rounded text-[10px] text-white font-medium transition-colors flex items-center justify-center gap-1"
              >
                <StopCircle className="w-3 h-3" />
                Stop
              </button>
            ) : (
              <button
                onClick={onStopMakeGif}
                className="flex-1 px-3 py-1.5 bg-red-600 hover:bg-red-500 rounded text-[10px] text-white font-medium transition-colors flex items-center justify-center gap-1"
              >
                <StopCircle className="w-3 h-3" />
                Cancel GIF
              </button>
            )}
          </div>
          {/* Animation Progress */}
          {isAnimating && animationProgress !== null && (
            <div className="mt-2">
              <div className="flex items-center justify-between text-[9px] text-neutral-400 mb-1">
                <span>Progress</span>
                <span>{animationProgress} / {animationEndAge} days</span>
              </div>
              <div className="w-full bg-neutral-700 rounded-full h-1.5">
                <div
                  className="bg-green-500 h-1.5 rounded-full transition-all duration-100"
                  style={{
                    width: `${((animationProgress - parseInt(animationStartAge)) / (parseInt(animationEndAge) - parseInt(animationStartAge))) * 100}%`
                  }}
                />
              </div>
            </div>
          )}
          {/* GIF Progress */}
          {isGeneratingGif && gifProgress && (
            <div className="mt-2">
              <div className="flex items-center justify-between text-[9px] text-neutral-400 mb-1">
                <span>{gifProgress.phase === 'frames' ? 'Capturing frames' : 'Encoding GIF...'}</span>
                <span>{gifProgress.current} / {gifProgress.total}</span>
              </div>
              <div className="w-full bg-neutral-700 rounded-full h-1.5">
                <div
                  className="bg-purple-500 h-1.5 rounded-full transition-all duration-100"
                  style={{
                    width: `${(gifProgress.current / gifProgress.total) * 100}%`
                  }}
                />
              </div>
            </div>
          )}
        </div>

        {/* Loading Indicator */}
        {isAdvancingAge && (
          <div className="flex items-center gap-2 text-[9px] text-neutral-400">
            <Loader2 className="w-3 h-3 animate-spin" />
            Regenerating plant...
          </div>
        )}
      </div>
    </div>
  );
}
