"""Unit tests for pure geometric / skeleton helpers in main.py.

These functions are math-only (numpy, occasionally scipy.optimize). They have
deterministic outputs and don't need open3d or pyhelios, which makes them
the highest-ROI unit-test targets for the 80% coverage goal.
"""

import numpy as np
import pytest

import main


class TestFitCircleThrough3Points:
    def test_three_points_on_unit_circle_recovers_center_and_radius(self):
        pts = np.array([[1.0, 0.0], [0.0, 1.0], [-1.0, 0.0]])
        center, radius = main.fit_circle_through_3_points(pts)
        assert center is not None
        assert np.allclose(center, [0.0, 0.0], atol=1e-9)
        assert radius == pytest.approx(1.0, abs=1e-9)

    def test_collinear_points_return_none(self):
        pts = np.array([[0.0, 0.0], [1.0, 0.0], [2.0, 0.0]])
        center, radius = main.fit_circle_through_3_points(pts)
        assert center is None and radius is None

    def test_wrong_point_count_returns_none(self):
        pts = np.array([[0.0, 0.0], [1.0, 0.0]])
        center, radius = main.fit_circle_through_3_points(pts)
        assert center is None and radius is None


class TestFitCircleLeastSquares:
    def test_recovers_unit_circle_from_noisy_samples(self):
        rng = np.random.default_rng(42)
        thetas = np.linspace(0, 2 * np.pi, 50, endpoint=False)
        points = np.column_stack([np.cos(thetas), np.sin(thetas)])
        # Add small radial noise so it's a real least-squares problem
        points += rng.normal(0, 0.005, size=points.shape)
        result = main.fit_circle_least_squares(points)
        assert result["success"] is True
        assert np.allclose(result["center"], [0.0, 0.0], atol=0.02)
        assert result["radius"] == pytest.approx(1.0, abs=0.02)

    def test_too_few_points_returns_failure(self):
        result = main.fit_circle_least_squares(np.array([[0.0, 0.0], [1.0, 0.0]]))
        assert result == {"success": False}


class TestSkeletonMetrics:
    def test_skeleton_length_from_edges_sums_segment_lengths(self):
        # NB: main.py defines two functions named calculate_skeleton_length —
        # the second (line ~3091) shadows the first. The dict+edges variant
        # is the one used at the skeleton-extraction call site, exported here
        # under its unshadowed alias.
        nodes = {0: [0.0, 0.0, 0.0], 1: [0.0, 0.0, 1.0], 2: [0.0, 0.0, 3.0]}
        edges = [(0, 1), (1, 2)]
        assert main.calculate_skeleton_length_from_edges(nodes, edges) == pytest.approx(3.0)

    def test_skeleton_length_array_form_sums_consecutive_segments(self):
        # The shadowing definition takes an Nx3 array of skeleton points.
        pts = np.array([[0.0, 0.0, 0.0], [0.0, 0.0, 1.0], [0.0, 0.0, 3.0]])
        assert main.calculate_skeleton_length(pts) == pytest.approx(3.0)

    def test_skeleton_length_array_form_handles_too_few_points(self):
        assert main.calculate_skeleton_length(np.array([[0.0, 0.0, 0.0]])) == 0.0

    def test_count_branch_points_y_shape(self):
        # Node 1 is the fork: parent of 2 and 3.
        edges = [(0, 1), (1, 2), (1, 3)]
        # Degree map: 0->1, 1->3, 2->1, 3->1. One node with degree > 2.
        assert main.count_branch_points(edges) == 1

    def test_count_branch_points_straight_line(self):
        # No node has degree > 2.
        edges = [(0, 1), (1, 2), (2, 3)]
        assert main.count_branch_points(edges) == 0

    def test_count_branch_points_empty(self):
        assert main.count_branch_points([]) == 0


class TestQuantizeLabels:
    def test_nonlinear_quantization_spreads_high_labels(self):
        # Labels 1..100; nonlinear sqrt scaling should put label 1 at level 6
        # (sqrt(1/100) * 60 = 6.0) and label 100 at level 60.
        labels = np.arange(1, 101, dtype=np.int32)
        q = main.quantize_labels(labels, num_levels=60, use_nonlinear=True)
        assert q[0] == 6
        assert q[-1] == 60
        # Quantization should be monotonic non-decreasing for monotonic input
        assert np.all(np.diff(q) >= 0)

    def test_linear_quantization_is_linear(self):
        labels = np.array([10, 50, 100], dtype=np.int32)
        q = main.quantize_labels(labels, num_levels=10, use_nonlinear=False)
        # floor((10/100)*10)=1, floor((50/100)*10)=5, floor((100/100)*10)=10
        assert q.tolist() == [1, 5, 10]

    def test_all_invalid_labels_returns_zeros(self):
        labels = np.array([0, 0, -1], dtype=np.int32)
        q = main.quantize_labels(labels, num_levels=60)
        assert np.all(q == 0)


class TestSelectRootSet:
    def test_only_points_within_threshold_of_z_min_are_roots(self):
        points = np.array([
            [0.0, 0.0, 0.00],   # z_min
            [0.1, 0.0, 0.01],   # within threshold
            [0.0, 0.1, 0.05],   # outside default threshold (0.02)
            [0.0, 0.0, 1.00],   # tip of plant
        ])
        roots = main.select_root_set(points, threshold=0.02)
        assert sorted(roots) == [0, 1]

    def test_threshold_can_be_widened(self):
        points = np.array([
            [0.0, 0.0, 0.0],
            [0.0, 0.0, 0.05],
            [0.0, 0.0, 1.0],
        ])
        roots = main.select_root_set(points, threshold=0.1)
        assert sorted(roots) == [0, 1]


class TestBfsLabelPoints:
    def test_labels_propagate_from_root_along_chain(self):
        # 4-point chain: 0-1-2-3
        neighbors = [[1], [0, 2], [1, 3], [2]]
        labels = main.bfs_label_points(neighbors, root_indices=[0], n_points=4)
        # Root is label 1; each step adds 1.
        assert labels.tolist() == [1, 2, 3, 4]

    def test_unreachable_points_stay_minus_one(self):
        # 0-1 connected; 2-3 connected; no link between groups.
        neighbors = [[1], [0], [3], [2]]
        labels = main.bfs_label_points(neighbors, root_indices=[0], n_points=4)
        assert labels[0] == 1 and labels[1] == 2
        assert labels[2] == -1 and labels[3] == -1
