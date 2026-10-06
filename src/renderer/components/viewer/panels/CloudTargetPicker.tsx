import { ObjectPicker, type PickerItem } from '../../ObjectPicker';

/** A tool panel's cloud picker: every point cloud in the scene, with the ones
 *  the tool acts on checked. */
export interface CloudPicker {
  items: PickerItem[];
  selectedIds: Set<string>;
  onChange: (next: Set<string>) => void;
}

interface CloudTargetPickerProps {
  picker: CloudPicker;
  /** How many clouds are checked. */
  targetCount: number;
  /** Prefix of the test ids: `<prefix>-targets`, `<prefix>-target-row`,
   *  `<prefix>-none-checked`. */
  testIdPrefix: string;
  /** Shown under the list while nothing is checked, e.g. "Check the clouds to segment." */
  noneHint: string;
  /** Freezes the checked set (a run is working through it). */
  locked?: boolean;
}

/**
 * The "Clouds" list at the top of a segmentation panel. The panel acts on the
 * checked set — seeded from the Scans-pane selection when it opens — instead of
 * reading the pane's selection, so it opens for any number of selected scans
 * and a pane click while it is open does not change what it will run on.
 */
export function CloudTargetPicker({
  picker, targetCount, testIdPrefix, noneHint, locked = false,
}: CloudTargetPickerProps) {
  return (
    <div className="mb-3">
      <ObjectPicker
        items={picker.items}
        selectedIds={picker.selectedIds}
        onChange={locked ? () => {} : picker.onChange}
        label="Clouds"
        emptyMessage="No point clouds in the scene."
        rowTestId={`${testIdPrefix}-target-row`}
        data-testid={`${testIdPrefix}-targets`}
      />
      {targetCount === 0 && picker.items.length > 0 && (
        <p className="mt-1 text-[10px] text-neutral-500" data-testid={`${testIdPrefix}-none-checked`}>
          {noneHint}
        </p>
      )}
    </div>
  );
}
