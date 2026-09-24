package geo

import "math"

// SimplifyIndices runs Douglas-Peucker on pts with a tolerance in metres and
// returns the indices of the points to keep (always including the first and
// last point). The distance is measured on a local equirectangular projection,
// which is accurate enough for track display.
func SimplifyIndices(pts []Point, toleranceM float64) []int {
	n := len(pts)
	if n <= 2 || toleranceM <= 0 {
		idx := make([]int, n)
		for i := range idx {
			idx[i] = i
		}
		return idx
	}
	// Project to metres around the mean latitude.
	meanLat := 0.0
	for _, p := range pts {
		meanLat += p.Lat
	}
	meanLat /= float64(n)
	kx := 111320.0 * math.Cos(meanLat*math.Pi/180)
	ky := 110540.0
	xs := make([]float64, n)
	ys := make([]float64, n)
	for i, p := range pts {
		xs[i] = p.Lng * kx
		ys[i] = p.Lat * ky
	}

	keep := make([]bool, n)
	keep[0], keep[n-1] = true, true
	type span struct{ a, b int }
	stack := []span{{0, n - 1}}
	tol2 := toleranceM * toleranceM
	for len(stack) > 0 {
		s := stack[len(stack)-1]
		stack = stack[:len(stack)-1]
		if s.b-s.a < 2 {
			continue
		}
		maxD, maxI := -1.0, -1
		for i := s.a + 1; i < s.b; i++ {
			d := segDist2(xs[i], ys[i], xs[s.a], ys[s.a], xs[s.b], ys[s.b])
			if d > maxD {
				maxD, maxI = d, i
			}
		}
		if maxD > tol2 {
			keep[maxI] = true
			stack = append(stack, span{s.a, maxI}, span{maxI, s.b})
		}
	}
	out := make([]int, 0, n/4+2)
	for i, k := range keep {
		if k {
			out = append(out, i)
		}
	}
	return out
}

// Simplify returns the simplified polyline.
func Simplify(pts []Point, toleranceM float64) []Point {
	idx := SimplifyIndices(pts, toleranceM)
	out := make([]Point, len(idx))
	for i, j := range idx {
		out[i] = pts[j]
	}
	return out
}

// segDist2 returns the squared distance from p to segment a-b.
func segDist2(px, py, ax, ay, bx, by float64) float64 {
	dx, dy := bx-ax, by-ay
	if dx == 0 && dy == 0 {
		return (px-ax)*(px-ax) + (py-ay)*(py-ay)
	}
	t := ((px-ax)*dx + (py-ay)*dy) / (dx*dx + dy*dy)
	if t < 0 {
		t = 0
	} else if t > 1 {
		t = 1
	}
	cx, cy := ax+t*dx, ay+t*dy
	return (px-cx)*(px-cx) + (py-cy)*(py-cy)
}
