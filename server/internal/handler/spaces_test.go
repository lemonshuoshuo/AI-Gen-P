package handler

import (
	"fmt"
	"strings"
	"testing"
	"time"

	"triphub/internal/db"
	"triphub/internal/model"
)

// inviteTo invites username to a space as tok and returns the invitation.
func (e *env) inviteTo(space int64, tok, username string) map[string]any {
	e.t.Helper()
	return e.must(200, "POST", fmt.Sprintf("/spaces/%d/invites", space), tok, map[string]any{"username": username}).obj(e.t)
}

// join has tok invite username to a space, and member (username's token) accept.
func (e *env) join(space int64, tok, username, member string) {
	e.t.Helper()
	inv := e.inviteTo(space, tok, username)
	e.must(200, "POST", fmt.Sprintf("/space-invites/%d/accept", id(inv)), member, nil)
}

// notices returns the notifications of type typ tok received, newest first.
func (e *env) notices(tok, typ string) []map[string]any {
	e.t.Helper()
	var out []map[string]any
	for _, it := range items(e.t, e.must(200, "GET", "/notifications?page_size=50", tok, nil)) {
		if n := it.(map[string]any); n["type"] == typ {
			out = append(out, n)
		}
	}
	return out
}

// spaceOf returns the space reference of a trip card (nil: none shown).
func spaceOf(card map[string]any) map[string]any {
	sp, _ := card["space"].(map[string]any)
	return sp
}

// Spaces are created with a type (a custom one named), listed in the order
// joined, changed by their owner (both members of a couple space) and
// deleted by the owner; everything is 404 to non-members. The default
// space follows membership.
func TestSpacesLifecycle(t *testing.T) {
	e := setup(t)
	alice, _, aliceID := e.register("alice")
	bob, _, _ := e.register("bob")

	tomorrow := time.Now().In(e.svc.Loc).AddDate(0, 0, 1).Format("2006-01-02")
	for _, bad := range []map[string]any{
		{"name": "没有类型"},
		{"type": "gang"},
		{"type": "custom"}, // a custom type needs its name
		{"type": "custom", "type_label": "这是一个超过十个字的类型名"},
		{"type": "friends", "name": strings.Repeat("长", 31)},
		{"type": "friends", "description": strings.Repeat("长", 121)},
		{"type": "friends", "anniversary": tomorrow},
		{"type": "friends", "anniversary": "2023-13-01"},
		{"type": "friends", "public": true}, // only couples show on profiles
	} {
		e.must(400, "POST", "/spaces", alice, bad)
	}

	fr := e.must(200, "POST", "/spaces", alice, map[string]any{"type": "friends", "type_label": "ignored"}).obj(t)
	if fr["name"] != "朋友们" || fr["type"] != "friends" || fr["type_label"] != "朋友" || fr["role"] != "owner" ||
		num(fr["member_count"]) != 1 || fr["can_manage"] != true || fr["can_invite"] != true || fr["is_default"] != false ||
		num(fr["trip_count"]) != 0 || fr["last_trip"] != nil || fr["anniversary"] != nil || len(fr["invites"].([]any)) != 0 ||
		num(fr["stats"].(map[string]any)["trip_count"]) != 0 || id(fr["owner"].(map[string]any)) != aliceID {
		t.Fatalf("new space: %v", fr)
	}
	if m := fr["members"].([]any)[0].(map[string]any); id(m) != aliceID || m["space_role"] != "owner" || m["joined_at"] == nil || m["role"] != "user" {
		t.Fatalf("space member: %v", m)
	}
	custom := e.must(200, "POST", "/spaces", alice, map[string]any{"type": "custom", "type_label": " 驴友团 ", "name": "周末爬山",
		"description": "每月一次"}).obj(t)
	if custom["type_label"] != "驴友团" || custom["name"] != "周末爬山" || custom["description"] != "每月一次" {
		t.Fatalf("custom space: %v", custom)
	}
	couple := e.must(200, "POST", "/spaces", alice, map[string]any{"type": "couple", "anniversary": "2023-05-20"}).obj(t)
	if couple["name"] != "我们" || couple["type_label"] != "情侣" || couple["anniversary"] != "2023-05-20" {
		t.Fatalf("couple space: %v", couple)
	}
	e.must(409, "POST", "/spaces", alice, map[string]any{"type": "couple"}) // one couple space each
	frPath, customPath, couplePath := fmt.Sprintf("/spaces/%d", id(fr)), fmt.Sprintf("/spaces/%d", id(custom)), fmt.Sprintf("/spaces/%d", id(couple))

	list := e.must(200, "GET", "/spaces", alice, nil).arr(t)
	if len(list) != 3 || id(list[0].(map[string]any)) != id(fr) || id(list[2].(map[string]any)) != id(couple) {
		t.Fatalf("spaces: %v", list)
	}
	// Non-members: nothing.
	if l := e.must(200, "GET", "/spaces", bob, nil).arr(t); len(l) != 0 {
		t.Fatalf("bob's spaces: %v", l)
	}
	for _, r := range [][2]string{{"GET", frPath}, {"PATCH", frPath}, {"DELETE", frPath}, {"GET", frPath + "/trips"},
		{"GET", frPath + "/footprints"}, {"POST", frPath + "/invites"}, {"DELETE", fmt.Sprintf("%s/members/%d", frPath, aliceID)}} {
		e.must(404, r[0], r[1], bob, map[string]any{"name": "x", "username": "bob"})
	}
	e.must(404, "GET", "/spaces/999999", alice, nil)
	e.must(401, "GET", "/spaces", "", nil)

	// Changes.
	p := e.must(200, "PATCH", frPath, alice, map[string]any{"name": " 老友记 ", "description": "大学室友"}).obj(t)
	if p["name"] != "老友记" || p["description"] != "大学室友" || p["type"] != "friends" {
		t.Fatalf("patched: %v", p)
	}
	e.must(400, "PATCH", frPath, alice, map[string]any{"name": ""})
	e.must(400, "PATCH", frPath, alice, map[string]any{"type": "custom"})
	if p := e.must(200, "PATCH", frPath, alice, map[string]any{"type": "custom", "type_label": "室友"}).obj(t); p["type_label"] != "室友" {
		t.Fatalf("custom type: %v", p)
	}
	if p := e.must(200, "PATCH", frPath, alice, map[string]any{"type": "family"}).obj(t); p["type_label"] != "家人" || p["type"] != "family" {
		t.Fatalf("back to a built-in type: %v", p)
	}
	e.must(409, "PATCH", frPath, alice, map[string]any{"type": "couple"}) // alice has a couple space already
	e.must(400, "PATCH", frPath, alice, map[string]any{"public": true})
	e.must(400, "PATCH", couplePath, alice, map[string]any{"anniversary": tomorrow})
	if p := e.must(200, "PATCH", couplePath, alice, map[string]any{"anniversary": nil, "public": true}).obj(t); p["anniversary"] != nil || p["public"] != true {
		t.Fatalf("couple settings: %v", p)
	}

	// Members may not change or delete the space; both members of a couple may change theirs.
	e.join(id(fr), alice, "bob", bob)
	e.must(403, "PATCH", frPath, bob, map[string]any{"name": "我的"})
	e.must(403, "DELETE", frPath, bob, nil)
	if d := e.must(200, "GET", frPath, bob, nil).obj(t); d["role"] != "member" || d["can_manage"] != false || d["can_invite"] != true ||
		num(d["member_count"]) != 2 || d["members"].([]any)[0].(map[string]any)["space_role"] != "owner" {
		t.Fatalf("member's view: %v", d)
	}

	// The default space.
	if me := e.must(200, "PUT", "/me/default-space", alice, map[string]any{"space_id": id(custom)}).obj(t); num(me["default_space_id"]) != float64(id(custom)) {
		t.Fatalf("default space: %v", me["default_space_id"])
	}
	if me := e.must(200, "GET", "/me", alice, nil).obj(t); num(me["default_space_id"]) != float64(id(custom)) {
		t.Fatalf("me.default_space_id: %v", me["default_space_id"])
	}
	for _, s := range e.must(200, "GET", "/spaces", alice, nil).arr(t) {
		if m := s.(map[string]any); m["is_default"] != (id(m) == id(custom)) {
			t.Fatalf("is_default: %v", m)
		}
	}
	e.must(404, "PUT", "/me/default-space", bob, map[string]any{"space_id": id(custom)})
	if me := e.must(200, "PUT", "/me/default-space", alice, map[string]any{"space_id": nil}).obj(t); me["default_space_id"] != nil {
		t.Fatalf("cleared default: %v", me["default_space_id"])
	}
	e.must(200, "PUT", "/me/default-space", alice, map[string]any{"space_id": id(custom)})
	e.must(200, "PUT", "/me/default-space", bob, map[string]any{"space_id": id(fr)})
	e.must(200, "DELETE", customPath, alice, nil) // deleting the default space clears it
	if me := e.must(200, "GET", "/me", alice, nil).obj(t); me["default_space_id"] != nil {
		t.Fatalf("default of a deleted space: %v", me["default_space_id"])
	}
	e.must(404, "GET", customPath, alice, nil)
	e.must(200, "DELETE", fmt.Sprintf("%s/members/%s", frPath, fmt.Sprint(id(e.must(200, "GET", "/me", bob, nil).obj(t)))), bob, nil)
	if me := e.must(200, "GET", "/me", bob, nil).obj(t); me["default_space_id"] != nil {
		t.Fatalf("default of a space left: %v", me["default_space_id"])
	}
	// Deleting tells the other members.
	e.join(id(fr), alice, "bob", bob)
	e.must(200, "DELETE", frPath, alice, nil)
	if n := e.notices(bob, "system"); len(n) == 0 || !strings.Contains(n[0]["content"].(string), "删除了空间「老友记」") || n[0]["space"] != nil {
		t.Fatalf("deleted space notice: %v", n)
	}
	if l := e.must(200, "GET", "/spaces", bob, nil).arr(t); len(l) != 0 {
		t.Fatalf("bob still in a deleted space: %v", l)
	}
}

// Invitations: to a user by name or ID, answered by them only; any member of
// a group space may invite, the owner of a couple space invites the one
// partner it may have; each step is notified.
func TestSpaceInvites(t *testing.T) {
	e := setup(t)
	alice, _, aliceID := e.register("alice")
	bob, _, bobID := e.register("bob")
	carol, _, carolID := e.register("carol")
	dave, _, _ := e.register("dave")
	sp := id(e.must(200, "POST", "/spaces", alice, map[string]any{"type": "besties", "name": "姐妹"}).obj(t))
	invites := fmt.Sprintf("/spaces/%d/invites", sp)

	e.must(400, "POST", invites, alice, map[string]any{})
	e.must(404, "POST", invites, alice, map[string]any{"username": "nobody"})
	e.must(400, "POST", invites, alice, map[string]any{"username": "alice"})
	e.must(400, "POST", invites, alice, map[string]any{"username": "bob", "message": strings.Repeat("话", 201)})
	inv := e.must(200, "POST", invites, alice, map[string]any{"username": "@Bob", "message": "一起玩"}).obj(t)
	if inv["status"] != "pending" || inv["message"] != "一起玩" || id(inv["inviter"].(map[string]any)) != aliceID ||
		id(inv["invitee"].(map[string]any)) != bobID || inv["space"].(map[string]any)["name"] != "姐妹" ||
		num(inv["space"].(map[string]any)["member_count"]) != 1 || len(inv["space"].(map[string]any)["members"].([]any)) != 1 {
		t.Fatalf("invite: %v", inv)
	}
	e.must(409, "POST", invites, alice, map[string]any{"username": "bob"})
	e.must(404, "POST", invites, bob, map[string]any{"username": "carol"}) // not a member yet
	if si := e.must(200, "GET", "/space-invites", bob, nil).obj(t); len(si["incoming"].([]any)) != 1 || len(si["outgoing"].([]any)) != 0 {
		t.Fatalf("bob's invites: %v", si)
	}
	if si := e.must(200, "GET", "/space-invites", alice, nil).obj(t); len(si["outgoing"].([]any)) != 1 {
		t.Fatalf("alice's invites: %v", si)
	}
	if mi := e.must(200, "GET", "/me/invites", bob, nil).obj(t); len(mi["space_invites"].([]any)) != 1 || len(mi["partner_invites"].([]any)) != 0 {
		t.Fatalf("/me/invites: %v", mi)
	}
	if n := e.notices(bob, "space_invite"); len(n) != 1 || n[0]["content"] != "一起玩" || n[0]["invite_pending"] != true ||
		num(n[0]["space_invite_id"]) != float64(id(inv)) || id(n[0]["space"].(map[string]any)) != sp {
		t.Fatalf("space_invite notice: %v", n)
	}
	if d := e.must(200, "GET", fmt.Sprintf("/spaces/%d", sp), alice, nil).obj(t); len(d["invites"].([]any)) != 1 || num(d["pending_invite_count"]) != 1 {
		t.Fatalf("pending invites of the space: %v", d)
	}
	accept := fmt.Sprintf("/space-invites/%d/accept", id(inv))
	e.must(404, "POST", accept, carol, nil)
	e.must(404, "POST", fmt.Sprintf("/space-invites/%d/decline", id(inv)), alice, nil) // only the invitee declines
	e.must(404, "DELETE", fmt.Sprintf("/space-invites/%d", id(inv)), carol, nil)
	if d := e.must(200, "POST", accept, bob, nil).obj(t); d["role"] != "member" || num(d["member_count"]) != 2 || len(d["invites"].([]any)) != 0 {
		t.Fatalf("joined: %v", d)
	}
	e.must(404, "POST", accept, bob, nil)
	e.must(409, "POST", invites, alice, map[string]any{"username": "bob"})
	if n := e.notices(alice, "space_accept"); len(n) != 1 || id(n[0]["actor"].(map[string]any)) != bobID || id(n[0]["space"].(map[string]any)) != sp {
		t.Fatalf("space_accept notice: %v", n)
	}
	if n := e.notices(bob, "space_invite"); n[0]["invite_pending"] != false || n[0]["space_invite_id"] != nil {
		t.Fatalf("answered invite notice: %v", n)
	}

	// Any member of a group space invites; the invitee may decline.
	inv2 := e.must(200, "POST", invites, bob, map[string]any{"user_id": carolID}).obj(t)
	e.must(200, "POST", fmt.Sprintf("/space-invites/%d/decline", id(inv2)), carol, nil)
	if n := e.notices(bob, "space_decline"); len(n) != 1 || !strings.Contains(n[0]["content"].(string), "姐妹") {
		t.Fatalf("space_decline notice: %v", n)
	}
	// A declined invitation may be renewed; the inviter or the owner may withdraw it.
	inv3 := e.must(200, "POST", invites, bob, map[string]any{"username": "carol"}).obj(t)
	e.must(200, "DELETE", fmt.Sprintf("/space-invites/%d", id(inv3)), alice, nil)
	e.must(404, "POST", fmt.Sprintf("/space-invites/%d/accept", id(inv3)), carol, nil)
	if n := e.notices(carol, "space_invite"); len(n) != 2 || n[0]["invite_pending"] != false || n[0]["space"] != nil {
		t.Fatalf("withdrawn invite notice: %v", n)
	}

	// Couple spaces: two people, one invitation at a time, from the owner.
	cp := id(e.must(200, "POST", "/spaces", carol, map[string]any{"type": "couple"}).obj(t))
	cpInvites := fmt.Sprintf("/spaces/%d/invites", cp)
	ci := e.must(200, "POST", cpInvites, carol, map[string]any{"username": "dave"}).obj(t)
	e.must(409, "POST", cpInvites, carol, map[string]any{"username": "alice"}) // one pending at a time
	e.must(200, "POST", fmt.Sprintf("/space-invites/%d/accept", id(ci)), dave, nil)
	e.must(409, "POST", cpInvites, carol, map[string]any{"username": "alice"}) // full
	e.must(403, "POST", cpInvites, dave, map[string]any{"username": "alice"})  // the owner invites
	if d := e.must(200, "PATCH", fmt.Sprintf("/spaces/%d", cp), dave, map[string]any{"name": "卡卡和大卫"}).obj(t); d["name"] != "卡卡和大卫" ||
		d["can_manage"] != true || d["can_invite"] != false {
		t.Fatalf("couple member changes the space: %v", d)
	}
	e.must(403, "DELETE", fmt.Sprintf("/spaces/%d", cp), dave, nil)
	// A partnered user cannot be invited to another couple space.
	ac := id(e.must(200, "POST", "/spaces", alice, map[string]any{"type": "couple"}).obj(t))
	e.must(409, "POST", fmt.Sprintf("/spaces/%d/invites", ac), alice, map[string]any{"username": "dave"})
	// Joining a couple space drops an empty one of one's own that waits for a
	// partner, and withdraws its invitation; one with trips is kept (409).
	bi := e.must(200, "POST", fmt.Sprintf("/spaces/%d/invites", ac), alice, map[string]any{"username": "bob"}).obj(t)
	bc := e.must(200, "POST", "/spaces", bob, map[string]any{"type": "couple", "name": "等你"}).obj(t)
	trip := id(e.must(200, "POST", "/trips", bob, map[string]any{"title": "独行", "space_id": id(bc)}).obj(t))
	e.must(409, "POST", fmt.Sprintf("/space-invites/%d/accept", id(bi)), bob, nil)
	e.must(200, "PATCH", fmt.Sprintf("/trips/%d", trip), bob, map[string]any{"space_id": nil})
	e.must(200, "POST", fmt.Sprintf("/space-invites/%d/accept", id(bi)), bob, nil)
	e.must(404, "GET", fmt.Sprintf("/spaces/%d", id(bc)), bob, nil)
	if p := e.must(200, "GET", "/partner", bob, nil).obj(t); p["partner"] == nil || id(p["partner"].(map[string]any)) != aliceID {
		t.Fatalf("bob's partner: %v", p)
	}
	// Spaces of every kind: a group space of the couple, and bob in both.
	if l := e.must(200, "GET", "/spaces", bob, nil).arr(t); len(l) != 2 {
		t.Fatalf("bob's spaces: %v", l)
	}
}

// A trip linked to a space is open to its members exactly as to an accepted
// co-author, and to no one else: not to other users, not to those only
// invited to the space, and no longer to members who left or were removed.
func TestSpaceTripAccess(t *testing.T) {
	e := setup(t)
	alice, _, aliceID := e.register("alice")
	bob, _, bobID := e.register("bob")
	carol, _, _ := e.register("carol")
	dave, _, _ := e.register("dave")
	sp := id(e.must(200, "POST", "/spaces", alice, map[string]any{"type": "friends"}).obj(t))
	e.join(sp, alice, "bob", bob)
	e.inviteTo(sp, alice, "dave") // not accepted

	e.must(404, "POST", "/trips", carol, map[string]any{"title": "别人的空间", "space_id": sp})
	d := e.must(200, "POST", "/trips", alice, map[string]any{"title": "秘密基地", "phase": "ongoing", "space_id": sp}).obj(t)
	trip := id(d)
	if s := spaceOf(d); s == nil || id(s) != sp || s["type"] != "friends" || d["together"] != false {
		t.Fatalf("linked trip: %v", d)
	}
	tp := fmt.Sprintf("/trips/%d", trip)
	wp := e.must(200, "POST", tp+"/waypoints", alice, map[string]any{"name": "秘密小店", "lng": 120.1300, "lat": 30.2700, "planned": true}).obj(t)
	wpID, placeID := id(wp), int64(num(wp["place_id"]))
	if placeID == 0 {
		t.Fatal("no place")
	}

	// bob, a member of the space, has a co-author's rights...
	bd := e.must(200, "GET", tp, bob, nil).obj(t)
	if bd["can_edit"] != true || bd["is_owner"] != false || bd["share_code"] == nil || len(bd["waypoints"].([]any)) != 1 || spaceOf(bd) == nil {
		t.Fatalf("space member's view: %v", bd)
	}
	e.must(200, "GET", tp+"/members", bob, nil)
	e.must(200, "PATCH", tp, bob, map[string]any{"title": "我们的秘密基地"})
	e.must(200, "POST", tp+"/waypoints", bob, map[string]any{"name": "湖边", "lng": 120.1500, "lat": 30.2600})
	e.must(200, "PATCH", fmt.Sprintf("/waypoints/%d", wpID), bob, map[string]any{"note": "早点去"})
	e.must(200, "POST", fmt.Sprintf("/waypoints/%d/checkin", wpID), bob, nil)
	ph := e.upload(tp+"/photos", bob, testJPEG(t, 300, 200), nil)
	if ph.status != 200 {
		t.Fatalf("upload: %d %s", ph.status, ph.body)
	}
	photo := id(ph.obj(t)["photo"].(map[string]any))
	e.must(200, "PATCH", fmt.Sprintf("/photos/%d", photo), bob, map[string]any{"caption": "好看"})
	now := time.Now().UnixMilli()
	e.must(200, "POST", tp+"/track", bob, map[string]any{"points": []any{
		map[string]any{"lng": 120.13, "lat": 30.27, "t": now - 60000}, map[string]any{"lng": 120.131, "lat": 30.27, "t": now}}})
	if tr := e.must(200, "GET", tp+"/track", bob, nil).obj(t); num(tr["point_count"]) != 2 {
		t.Fatalf("track: %v", tr)
	}
	e.must(200, "POST", tp+"/comments", bob, map[string]any{"content": "等我"})
	e.must(200, "GET", tp+"/compare", bob, nil)
	e.must(200, "POST", tp+"/editing", bob, map[string]any{})
	rev := e.revisionOf(trip, bob)
	if num(rev["revision"]) < 2 || rev["updated_by"] == nil || len(rev["editors"].([]any)) != 1 {
		t.Fatalf("revision for a space member: %v", rev)
	}
	cur := e.must(200, "GET", tp, bob, nil).obj(t)
	e.must(200, "PUT", tp+"/plan", bob, map[string]any{"base_revision": cur["revision"],
		"trip":      map[string]any{"space_id": nil}, // ignored by a plan
		"waypoints": []any{map[string]any{"id": wpID}}})
	if s := spaceOf(e.must(200, "GET", tp, alice, nil).obj(t)); s == nil {
		t.Fatal("a plan unlinked the space")
	}
	// ... but not the author's.
	e.must(403, "PATCH", tp, bob, map[string]any{"visibility": "public"})
	e.must(403, "PATCH", tp, bob, map[string]any{"live_share": true})
	e.must(403, "PATCH", tp, bob, map[string]any{"space_id": nil}) // the author or the space's owner
	e.must(403, "DELETE", tp, bob, nil)
	e.must(403, "POST", tp+"/members", bob, map[string]any{"username": "carol"})
	e.must(403, "POST", tp+"/share-code/reset", bob, nil)
	e.must(404, "DELETE", fmt.Sprintf("%s/members/%d", tp, bobID), bob, nil) // no co-authorship to leave

	// Everyone else: nothing, also those only invited to the space.
	for _, tok := range []string{carol, dave} {
		e.must(404, "GET", tp, tok, nil)
		e.must(404, "GET", tp+"/revision", tok, nil)
		e.must(404, "GET", tp+"/track", tok, nil)
		e.must(404, "GET", tp+"/comments", tok, nil)
		e.must(404, "GET", tp+"/members", tok, nil)
		e.must(404, "POST", tp+"/waypoints", tok, map[string]any{"name": "x", "lng": 120, "lat": 30})
		e.must(404, "PATCH", fmt.Sprintf("/waypoints/%d", wpID), tok, map[string]any{"note": "x"})
		e.must(404, "PATCH", fmt.Sprintf("/photos/%d", photo), tok, map[string]any{"caption": "x"})
		e.must(404, "GET", fmt.Sprintf("/places/%d", placeID), tok, nil)
		if r := e.upload(tp+"/photos", tok, testJPEG(t, 60, 40), nil); r.status != 404 {
			t.Fatalf("outsider upload: %d", r.status)
		}
	}
	e.must(200, "GET", fmt.Sprintf("/places/%d", placeID), bob, nil)

	// Lists: the space's trips, the member's trips with their spaces', favourites.
	st := items(t, e.must(200, "GET", fmt.Sprintf("/spaces/%d/trips", sp), bob, nil))
	if len(st) != 1 || spaceOf(st[0].(map[string]any)) == nil || num(st[0].(map[string]any)["visited_count"]) == 0 ||
		num(st[0].(map[string]any)["photo_count"]) != 1 || num(st[0].(map[string]any)["revision"]) == 0 {
		t.Fatalf("space trips (not masked for members): %v", st)
	}
	if n := len(items(t, e.must(200, "GET", "/me/trips", bob, nil))); n != 0 {
		t.Fatalf("bob takes no part in the trip: %d", n)
	}
	if n := len(items(t, e.must(200, "GET", "/me/trips?include_spaces=true", bob, nil))); n != 1 {
		t.Fatalf("/me/trips?include_spaces: %d", n)
	}
	e.must(200, "POST", tp+"/favorite", bob, nil)
	if n := len(items(t, e.must(200, "GET", "/me/favorites", bob, nil))); n != 1 {
		t.Fatalf("favourites: %d", n)
	}
	// A reply to bob about the trip names it while he may open it.
	cm := items(t, e.must(200, "GET", tp+"/comments", alice, nil))[0].(map[string]any)
	e.must(200, "POST", tp+"/comments", alice, map[string]any{"content": "好", "parent_id": id(cm)})
	if n := e.notices(bob, "reply"); len(n) != 1 || n[0]["trip"] == nil {
		t.Fatalf("reply notice: %v", n)
	}

	// Removing bob from the space ends all of it.
	e.must(200, "DELETE", fmt.Sprintf("/spaces/%d/members/%d", sp, bobID), alice, nil)
	e.must(404, "GET", tp, bob, nil)
	e.must(404, "GET", tp+"/revision", bob, nil)
	e.must(404, "POST", tp+"/editing", bob, nil)
	e.must(404, "PATCH", fmt.Sprintf("/waypoints/%d", wpID), bob, map[string]any{"note": "x"})
	e.must(404, "PATCH", fmt.Sprintf("/photos/%d", photo), bob, map[string]any{"caption": "x"})
	e.must(404, "GET", fmt.Sprintf("/places/%d", placeID), bob, nil)
	e.must(404, "GET", fmt.Sprintf("/spaces/%d/trips", sp), bob, nil)
	if n := len(items(t, e.must(200, "GET", "/me/favorites", bob, nil))); n != 0 {
		t.Fatalf("favourite of a trip no longer open: %d", n)
	}
	if n := len(items(t, e.must(200, "GET", "/me/trips?include_spaces=true", bob, nil))); n != 0 {
		t.Fatalf("/me/trips after removal: %d", n)
	}
	if n := e.notices(bob, "reply"); n[0]["trip"] != nil || n[0]["content"] != "" {
		t.Fatalf("reply notice after removal: %v", n)
	}
	if n := e.notices(bob, "system"); len(n) != 1 || !strings.Contains(n[0]["content"].(string), "将你移出了空间") || n[0]["space"] != nil {
		t.Fatalf("removal notice: %v", n)
	}
	if d := e.must(200, "GET", tp, alice, nil).obj(t); len(d["photos"].([]any)) != 1 { // what bob added stays
		t.Fatalf("bob's photo: %v", d["photos"])
	}

	// A co-author keeps the trip through the trip, not the space.
	e.must(200, "POST", tp+"/members", alice, map[string]any{"username": "carol"})
	e.must(200, "POST", tp+"/members/accept", carol, nil)
	e.must(200, "PATCH", tp, alice, map[string]any{"space_id": nil})
	if d := e.must(200, "GET", tp, carol, nil).obj(t); spaceOf(d) != nil || d["can_edit"] != true {
		t.Fatalf("co-author after unlinking: %v", d)
	}
	e.must(404, "GET", tp, dave, nil)

	// Linking: the author, to a space they belong to; the space's owner may unlink.
	bt := id(e.must(200, "POST", "/trips", bob, map[string]any{"title": "鲍勃的"}).obj(t))
	e.must(404, "PATCH", fmt.Sprintf("/trips/%d", bt), bob, map[string]any{"space_id": sp}) // bob left it
	e.join(sp, alice, "bob", bob)
	e.must(200, "POST", fmt.Sprintf("/space-invites/%d/accept", int64(num(e.notices(dave, "space_invite")[0]["space_invite_id"]))), dave, nil)
	before := num(e.revisionOf(bt, bob)["revision"])
	if d := e.must(200, "PATCH", fmt.Sprintf("/trips/%d", bt), bob, map[string]any{"space_id": sp}).obj(t); spaceOf(d) == nil ||
		num(d["revision"]) != before+1 {
		t.Fatalf("linked by its author: %v", d)
	}
	e.must(200, "GET", fmt.Sprintf("/trips/%d", bt), dave, nil)
	e.must(403, "PATCH", fmt.Sprintf("/trips/%d", bt), dave, map[string]any{"space_id": nil})
	// The space's owner unlinks it, and no longer sees it: {}.
	if r := e.must(200, "PATCH", fmt.Sprintf("/trips/%d", bt), alice, map[string]any{"space_id": nil}).obj(t); len(r) != 0 {
		t.Fatalf("unlinked by the space's owner: %v", r)
	}
	e.must(404, "GET", fmt.Sprintf("/trips/%d", bt), dave, nil)
	e.must(404, "GET", fmt.Sprintf("/trips/%d", bt), alice, nil)
	e.must(200, "GET", fmt.Sprintf("/trips/%d", bt), bob, nil)
	// Members of the trip's space are added as co-authors at once.
	e.must(200, "PATCH", tp, alice, map[string]any{"space_id": sp})
	e.must(200, "POST", tp+"/members", alice, map[string]any{"username": "dave"})
	if mem := e.must(200, "GET", tp+"/members", alice, nil).arr(t); mem[len(mem)-1].(map[string]any)["status"] != "accepted" {
		t.Fatalf("space member added: %v", mem)
	}
	_ = aliceID
}

// Leaving a space: the trips one owns leave with them, the others' stay;
// the owner leaving hands the space to the member who joined earliest, and
// the last member leaving deletes it.
func TestSpaceLeave(t *testing.T) {
	e := setup(t)
	alice, _, aliceID := e.register("alice")
	bob, _, bobID := e.register("bob")
	carol, _, carolID := e.register("carol")
	sp := id(e.must(200, "POST", "/spaces", alice, map[string]any{"type": "family", "name": "一家人"}).obj(t))
	e.join(sp, alice, "bob", bob)
	e.join(sp, alice, "carol", carol)
	at := id(e.must(200, "POST", "/trips", alice, map[string]any{"title": "全家游", "space_id": sp}).obj(t))
	bt := id(e.must(200, "POST", "/trips", bob, map[string]any{"title": "鲍勃游", "space_id": sp}).obj(t))
	for _, tok := range []string{alice, bob, carol} {
		e.must(200, "GET", fmt.Sprintf("/trips/%d", at), tok, nil)
		e.must(200, "GET", fmt.Sprintf("/trips/%d", bt), tok, nil)
	}
	rev := num(e.revisionOf(bt, bob)["revision"])

	e.must(403, "DELETE", fmt.Sprintf("/spaces/%d/members/%d", sp, aliceID), carol, nil)
	e.must(404, "DELETE", fmt.Sprintf("/spaces/%d/members/999999", sp), alice, nil)
	e.must(200, "DELETE", fmt.Sprintf("/spaces/%d/members/%d", sp, bobID), bob, nil)
	if d := e.must(200, "GET", fmt.Sprintf("/trips/%d", bt), bob, nil).obj(t); spaceOf(d) != nil || d["is_owner"] != true ||
		num(d["revision"]) != rev+1 {
		t.Fatalf("bob's trip after leaving: %v", d)
	}
	e.must(404, "GET", fmt.Sprintf("/trips/%d", bt), alice, nil)
	e.must(404, "GET", fmt.Sprintf("/trips/%d", bt), carol, nil)
	e.must(404, "GET", fmt.Sprintf("/trips/%d", at), bob, nil)
	e.must(200, "GET", fmt.Sprintf("/trips/%d", at), carol, nil)
	if n := e.notices(alice, "system"); len(n) != 1 || !strings.Contains(n[0]["content"].(string), "退出了空间「一家人」") {
		t.Fatalf("leave notice: %v", n)
	}

	// The owner leaves: carol (who joined before bob came back) takes over.
	e.join(sp, carol, "bob", bob)
	e.must(200, "PUT", "/me/default-space", alice, map[string]any{"space_id": sp})
	e.must(200, "DELETE", fmt.Sprintf("/spaces/%d/members/%d", sp, aliceID), alice, nil)
	d := e.must(200, "GET", fmt.Sprintf("/spaces/%d", sp), carol, nil).obj(t)
	if id(d["owner"].(map[string]any)) != carolID || d["role"] != "owner" || num(d["member_count"]) != 2 || num(d["trip_count"]) != 0 {
		t.Fatalf("new owner: %v", d)
	}
	if n := e.notices(carol, "system"); len(n) == 0 || !strings.Contains(n[0]["content"].(string), "你成为了空间的创建者") {
		t.Fatalf("new owner notice: %v", n)
	}
	if me := e.must(200, "GET", "/me", alice, nil).obj(t); me["default_space_id"] != nil {
		t.Fatalf("default space left: %v", me["default_space_id"])
	}
	e.must(404, "GET", fmt.Sprintf("/trips/%d", at), carol, nil) // alice's trip left with her
	e.must(200, "GET", fmt.Sprintf("/trips/%d", at), alice, nil)

	// The last one out deletes it.
	e.must(200, "DELETE", fmt.Sprintf("/spaces/%d/members/%d", sp, bobID), carol, nil)
	e.must(200, "DELETE", fmt.Sprintf("/spaces/%d/members/%d", sp, carolID), carol, nil)
	var n int64
	e.svc.DB.Model(&model.Space{}).Where("id = ?", sp).Count(&n)
	if n != 0 {
		t.Fatal("empty space kept")
	}
}

// At most 20 spaces per user and 50 members per space (pending invitations
// included).
func TestSpaceLimits(t *testing.T) {
	e := setup(t)
	alice, _, aliceID := e.register("alice")
	bob, _, _ := e.register("bob")
	var first int64
	for i := 0; i < 20; i++ {
		sp := id(e.must(200, "POST", "/spaces", alice, map[string]any{"type": "friends", "name": fmt.Sprintf("第%d个", i+1)}).obj(t))
		if i == 0 {
			first = sp
		}
	}
	e.must(400, "POST", "/spaces", alice, map[string]any{"type": "friends"})
	bs := id(e.must(200, "POST", "/spaces", bob, map[string]any{"type": "friends"}).obj(t))
	e.must(409, "POST", fmt.Sprintf("/spaces/%d/invites", bs), bob, map[string]any{"username": "alice"})
	e.must(200, "DELETE", fmt.Sprintf("/spaces/%d", first), alice, nil)
	inv := e.inviteTo(bs, bob, "alice")
	e.must(200, "POST", "/spaces", alice, map[string]any{"type": "friends"}) // 20 again
	e.must(409, "POST", fmt.Sprintf("/space-invites/%d/accept", id(inv)), alice, nil)

	// 50 members: bob's space gets 48 more, then one invitation fills it.
	gdb := e.svc.DB
	for i := 0; i < 48; i++ {
		u := model.User{Username: fmt.Sprintf("m%02d", i), PasswordHash: "x", Status: model.UserActive, Role: model.RoleUser}
		if err := gdb.Create(&u).Error; err != nil {
			t.Fatal(err)
		}
		if err := gdb.Create(&model.SpaceMember{SpaceID: bs, UserID: u.ID, Role: model.SpaceRoleMember, JoinedAt: time.Now()}).Error; err != nil {
			t.Fatal(err)
		}
	}
	carol, _, _ := e.register("carol")
	e.register("dave")
	e.must(200, "DELETE", fmt.Sprintf("/space-invites/%d", id(inv)), bob, nil)
	ci := e.inviteTo(bs, bob, "carol") // 49 members + 1 pending
	e.must(400, "POST", fmt.Sprintf("/spaces/%d/invites", bs), bob, map[string]any{"username": "dave"})
	if d := e.must(200, "GET", fmt.Sprintf("/spaces/%d", bs), bob, nil).obj(t); d["can_invite"] != false || num(d["member_count"]) != 49 {
		t.Fatalf("full space: %v %v", d["can_invite"], d["member_count"])
	}
	e.must(200, "POST", fmt.Sprintf("/space-invites/%d/accept", id(ci)), carol, nil)
	_ = aliceID
}

// Couples of older versions become couple spaces when the server starts:
// with their title, anniversary and profile setting, owned by whoever sent
// the invitation, their shared trips linked, as both partners' default
// space; pending invitations follow. Doing it again changes nothing.
func TestPartnerSpaceMigration(t *testing.T) {
	e := setup(t)
	alice, _, aliceID := e.register("alice")
	bob, _, bobID := e.register("bob")
	carol, _, carolID := e.register("carol")
	dave, _, daveID := e.register("dave")
	gdb := e.svc.DB
	mustExec := func(q string, args ...any) {
		t.Helper()
		if err := gdb.Exec(q, args...).Error; err != nil {
			t.Fatal(err)
		}
	}
	shared := id(e.must(200, "POST", "/trips", alice, map[string]any{"title": "一起去"}).obj(t))
	theirs := id(e.must(200, "POST", "/trips", bob, map[string]any{"title": "他的也是一起的"}).obj(t))
	solo := id(e.must(200, "POST", "/trips", alice, map[string]any{"title": "一个人"}).obj(t))
	other := id(e.must(200, "POST", "/trips", dave, map[string]any{"title": "别人的"}).obj(t))
	for _, m := range [][2]int64{{shared, bobID}, {theirs, aliceID}, {other, aliceID}, {other, bobID}} {
		mustExec("INSERT INTO trip_members (trip_id, user_id, role, status, invited_by_id, created_at, updated_at) VALUES (?, ?, 'editor', 'accepted', 0, now(), now())", m[0], m[1])
	}
	since := time.Date(2023, 5, 20, 0, 0, 0, 0, time.UTC)
	bound := time.Date(2024, 1, 2, 3, 4, 5, 0, time.UTC)
	if err := gdb.Create(&model.Partnership{UserA: aliceID, UserB: bobID, Since: &since, Title: "小窝", BoundAt: bound, Public: true}).Error; err != nil {
		t.Fatal(err)
	}
	if err := gdb.Create(&model.PartnerInvite{FromID: bobID, ToID: aliceID, Status: model.InviteAccepted}).Error; err != nil {
		t.Fatal(err)
	}
	if err := gdb.Create(&model.PartnerInvite{FromID: carolID, ToID: daveID, Message: "在一起吧", Status: model.InvitePending}).Error; err != nil {
		t.Fatal(err)
	}
	if err := db.Migrate(gdb); err != nil {
		t.Fatal(err)
	}

	list := e.must(200, "GET", "/spaces", alice, nil).arr(t)
	if len(list) != 1 {
		t.Fatalf("alice's spaces: %v", list)
	}
	sp := list[0].(map[string]any)
	if sp["type"] != "couple" || sp["name"] != "小窝" || sp["anniversary"] != "2023-05-20" || sp["public"] != true ||
		id(sp["owner"].(map[string]any)) != bobID || num(sp["member_count"]) != 2 || sp["is_default"] != true || num(sp["trip_count"]) != 2 {
		t.Fatalf("migrated couple space: %v", sp)
	}
	for _, tok := range []string{alice, bob} {
		if me := e.must(200, "GET", "/me", tok, nil).obj(t); num(me["default_space_id"]) != float64(id(sp)) || me["partner"] == nil {
			t.Fatalf("default space: %v", me)
		}
	}
	for tid, linked := range map[int64]bool{shared: true, theirs: true, solo: false, other: false} {
		d := e.must(200, "GET", fmt.Sprintf("/trips/%d", tid), alice, nil).obj(t)
		if (spaceOf(d) != nil) != linked || (linked && d["together"] != true) {
			t.Fatalf("trip %v linked=%v: space %v together %v", d["title"], linked, d["space"], d["together"])
		}
	}
	if p := e.must(200, "GET", "/partner", alice, nil).obj(t); p["title"] != "小窝" || p["since"] != "2023-05-20" ||
		id(p["partner"].(map[string]any)) != bobID || p["bound_at"] == nil || num(p["space_id"]) != float64(id(sp)) {
		t.Fatalf("partner: %v", p)
	}
	if pt := items(t, e.must(200, "GET", "/partner/trips", bob, nil)); len(pt) != 2 {
		t.Fatalf("partner trips: %v", pt)
	}
	// The pending invitation: carol's couple space, waiting for dave.
	in := e.must(200, "GET", "/space-invites", dave, nil).obj(t)["incoming"].([]any)
	if len(in) != 1 || in[0].(map[string]any)["message"] != "在一起吧" || in[0].(map[string]any)["space"].(map[string]any)["type"] != "couple" {
		t.Fatalf("migrated invitation: %v", in)
	}
	if pi := e.must(200, "GET", "/partner", dave, nil).obj(t)["invites"].(map[string]any)["incoming"].([]any); len(pi) != 1 {
		t.Fatalf("legacy incoming invitation: %v", pi)
	}
	// Again: nothing new.
	var before, after int64
	gdb.Model(&model.Space{}).Count(&before)
	if err := db.Migrate(gdb); err != nil {
		t.Fatal(err)
	}
	gdb.Model(&model.Space{}).Count(&after)
	var invites int64
	gdb.Model(&model.SpaceInvite{}).Count(&invites)
	if before != 2 || after != before || invites != 1 {
		t.Fatalf("spaces %d → %d, invitations %d", before, after, invites)
	}
	e.must(200, "POST", fmt.Sprintf("/space-invites/%d/accept", id(in[0].(map[string]any))), dave, nil)
	if p := e.must(200, "GET", "/partner", carol, nil).obj(t); p["partner"] == nil || id(p["partner"].(map[string]any)) != daveID {
		t.Fatalf("carol's partner: %v", p)
	}
}

// The deprecated /partner API works on the couple space: binding creates
// it, with_partner links a trip to it (and makes the partner a co-author),
// unbinding deletes it; cards show together trips and, to members, the space.
func TestPartnerOnSpaces(t *testing.T) {
	e := setup(t)
	alice, _, aliceID := e.register("alice")
	bob, _, bobID := e.register("bob")
	carol, _, _ := e.register("carol")
	inv := e.must(200, "POST", "/partner/invites", alice, map[string]any{"username": "bob"}).obj(t)
	e.must(409, "POST", "/partner/invites", bob, map[string]any{"username": "alice"}) // accept it instead
	if p := e.must(200, "GET", "/partner", alice, nil).obj(t); p["partner"] != nil || p["space_id"] == nil ||
		len(p["invites"].(map[string]any)["outgoing"].([]any)) != 1 {
		t.Fatalf("waiting: %v", p)
	}
	p := e.must(200, "POST", fmt.Sprintf("/partner/invites/%d/accept", id(inv)), bob, nil).obj(t)
	if id(p["partner"].(map[string]any)) != aliceID || p["title"] != "我们" {
		t.Fatalf("bound: %v", p)
	}
	spID := int64(num(p["space_id"]))
	e.must(200, "PATCH", "/partner", bob, map[string]any{"title": "", "since": "2024-02-14"})
	if d := e.must(200, "GET", fmt.Sprintf("/spaces/%d", spID), alice, nil).obj(t); d["name"] != "我们" || d["anniversary"] != "2024-02-14" {
		t.Fatalf("space after PATCH /partner: %v", d)
	}
	tr := e.must(200, "POST", "/trips", alice, map[string]any{"title": "一起", "with_partner": true, "visibility": "public"}).obj(t)
	if tr["together"] != true || spaceOf(tr) == nil || id(spaceOf(tr)) != spID || len(tr["members"].([]any)) != 1 {
		t.Fatalf("with_partner trip: %v", tr)
	}
	// A trip in the couple space is together without the partner as co-author.
	solo := e.must(200, "POST", "/trips", bob, map[string]any{"title": "他规划的", "space_id": spID, "visibility": "public"}).obj(t)
	if solo["together"] != true || len(solo["members"].([]any)) != 0 {
		t.Fatalf("couple space trip: %v", solo)
	}
	// Cards: the space only for its members; together for everyone.
	for _, c := range []struct {
		tok  string
		seen bool
	}{{"", false}, {carol, false}, {alice, true}} {
		for _, it := range items(t, e.must(200, "GET", "/trips", c.tok, nil)) {
			card := it.(map[string]any)
			if card["together"] != true || (spaceOf(card) != nil) != c.seen {
				t.Fatalf("card as %q: together %v space %v", c.tok, card["together"], card["space"])
			}
		}
	}
	if pt := items(t, e.must(200, "GET", "/partner/trips", alice, nil)); len(pt) != 2 {
		t.Fatalf("partner trips: %v", pt)
	}
	if fp := e.must(200, "GET", "/partner/footprints", alice, nil).obj(t); fp["stats"] == nil {
		t.Fatalf("partner footprints: %v", fp)
	}
	// Unbinding deletes the couple space; the co-authorship stays unless asked.
	e.must(200, "DELETE", "/partner", bob, nil)
	e.must(404, "GET", fmt.Sprintf("/spaces/%d", spID), alice, nil)
	if d := e.must(200, "GET", fmt.Sprintf("/trips/%d", id(tr)), bob, nil).obj(t); d["together"] != false || spaceOf(d) != nil {
		t.Fatalf("after unbinding: %v", d)
	}
	e.must(200, "GET", fmt.Sprintf("/trips/%d", id(solo)), alice, nil) // public
	if p := e.must(200, "GET", "/partner", alice, nil).obj(t); p["partner"] != nil || p["space_id"] != nil {
		t.Fatalf("partner after unbinding: %v", p)
	}
	if n := e.notices(alice, "system"); len(n) != 1 || !strings.Contains(n[0]["content"].(string), "解除了情侣绑定") {
		t.Fatalf("unbind notice: %v", n)
	}
	_ = bobID
}

// A space's statistics and footprints count its trips' visited stops, as
// personal footprints do.
func TestSpaceStatsAndFootprints(t *testing.T) {
	e := setup(t)
	alice, _, _ := e.register("alice")
	bob, _, _ := e.register("bob")
	sp := id(e.must(200, "POST", "/spaces", alice, map[string]any{"type": "couple"}).obj(t))
	e.join(sp, alice, "bob", bob)
	done := id(e.must(200, "POST", "/trips", alice, map[string]any{"title": "杭州苏州", "phase": "finished", "space_id": sp,
		"start_date": "2025-04-01", "end_date": "2025-04-03"}).obj(t))
	for _, w := range []map[string]any{
		{"name": "断桥", "lng": 120.1513, "lat": 30.2610, "planned": false, "arrived_at": "2025-04-01T10:00:00+08:00"},
		{"name": "拙政园", "lng": 120.6270, "lat": 31.3240, "planned": false, "arrived_at": "2025-04-02T10:00:00+08:00"},
	} {
		e.must(200, "POST", fmt.Sprintf("/trips/%d/waypoints", done), bob, w)
	}
	plan := id(e.must(200, "POST", "/trips", bob, map[string]any{"title": "下次去成都", "space_id": sp, "start_date": "2026-12-01"}).obj(t))
	e.must(200, "POST", "/trips", alice, map[string]any{"title": "不在空间里"})

	s := e.must(200, "GET", "/spaces", bob, nil).arr(t)[0].(map[string]any)
	if num(s["trip_count"]) != 2 || num(s["city_count"]) != 2 || id(s["last_trip"].(map[string]any)) != plan {
		t.Fatalf("space summary: %v", s)
	}
	st := e.must(200, "GET", fmt.Sprintf("/spaces/%d", sp), bob, nil).obj(t)["stats"].(map[string]any)
	if num(st["trip_count"]) != 2 || num(st["trips"]) != 1 || num(st["cities"]) != 2 || num(st["provinces"]) != 2 ||
		num(st["waypoints"]) != 2 || num(st["days"]) != 3 || st["first_date"] != "2025-04-01" || st["last_date"] != "2025-04-03" {
		t.Fatalf("space stats: %v", st)
	}
	fp := e.must(200, "GET", fmt.Sprintf("/spaces/%d/footprints", sp), alice, nil).obj(t)
	if len(fp["points"].([]any)) != 2 || len(fp["trips"].([]any)) != 1 || len(fp["cities"].([]any)) != 2 {
		t.Fatalf("space footprints: %v", fp)
	}
	if tl := items(t, e.must(200, "GET", fmt.Sprintf("/spaces/%d/trips", sp), alice, nil)); len(tl) != 2 || id(tl[0].(map[string]any)) != plan {
		t.Fatalf("space trips: %v", tl)
	}
	if tl := items(t, e.must(200, "GET", fmt.Sprintf("/spaces/%d/trips?phase=finished", sp), alice, nil)); len(tl) != 1 {
		t.Fatalf("finished trips: %v", tl)
	}
	e.must(400, "GET", fmt.Sprintf("/spaces/%d/trips?phase=later", sp), alice, nil)
	// Personal footprints count only the trips one takes part in.
	if mf := e.must(200, "GET", "/me/footprints", bob, nil).obj(t); num(mf["stats"].(map[string]any)["trips"]) != 0 {
		t.Fatalf("bob's own footprints: %v", mf["stats"])
	}
}

// Closing an account: the user leaves their spaces (the partner is told the
// couple ended; a new owner takes over a group space) and their trips leave
// the spaces before passing to a co-author.
func TestSpaceAccountDeletion(t *testing.T) {
	e := setup(t)
	alice, _, _ := e.register("alice")
	bob, _, bobID := e.register("bob")
	carol, _, carolID := e.register("carol")
	cp := id(e.must(200, "POST", "/spaces", alice, map[string]any{"type": "couple"}).obj(t))
	e.join(cp, alice, "bob", bob)
	gs := id(e.must(200, "POST", "/spaces", alice, map[string]any{"type": "friends"}).obj(t))
	e.join(gs, alice, "carol", carol)
	e.join(gs, alice, "bob", bob)
	shared := id(e.must(200, "POST", "/trips", alice, map[string]any{"title": "一起", "space_id": gs}).obj(t))
	e.must(200, "POST", fmt.Sprintf("/trips/%d/members", shared), alice, map[string]any{"username": "bob"}) // a space member: added at once
	e.must(200, "DELETE", "/me", alice, map[string]any{"password": "secret123"})

	if p := e.must(200, "GET", "/partner", bob, nil).obj(t); p["partner"] != nil {
		t.Fatalf("partner of a closed account: %v", p)
	}
	if n := e.notices(bob, "system"); len(n) == 0 || n[len(n)-1]["content"] != "对方已注销账号，情侣绑定已解除" {
		t.Fatalf("bob's notices: %v", n)
	}
	g := e.must(200, "GET", fmt.Sprintf("/spaces/%d", gs), carol, nil).obj(t)
	if id(g["owner"].(map[string]any)) != carolID || num(g["member_count"]) != 2 || num(g["trip_count"]) != 0 {
		t.Fatalf("group space after its owner left: %v", g)
	}
	d := e.must(200, "GET", fmt.Sprintf("/trips/%d", shared), bob, nil).obj(t)
	if id(d["author"].(map[string]any)) != bobID || spaceOf(d) != nil {
		t.Fatalf("shared trip: %v", d)
	}
	e.must(404, "GET", fmt.Sprintf("/trips/%d", shared), carol, nil)
}

// Concurrent requests keep the invariants: accepting two couple invitations
// at once joins one couple space; a trip being linked while its author is
// removed from the space never stays in a space its author has left.
func TestSpaceRaces(t *testing.T) {
	e := setup(t)
	alice, _, _ := e.register("alice")
	bob, _, bobID := e.register("bob")
	xavier, _, xavierID := e.register("xavier")
	ca := id(e.must(200, "POST", "/spaces", alice, map[string]any{"type": "couple"}).obj(t))
	cb := id(e.must(200, "POST", "/spaces", bob, map[string]any{"type": "couple"}).obj(t))
	invs := []int64{id(e.inviteTo(ca, alice, "xavier")), id(e.inviteTo(cb, bob, "xavier"))}
	codes := make([]int, 2)
	parallel(2, func(i int) {
		codes[i] = e.status("POST", fmt.Sprintf("/space-invites/%d/accept", invs[i]), xavier, nil)
	})
	// One joins; the other is refused (409), or finds its invitation already
	// withdrawn by the first (404).
	if other := codes[0] + codes[1] - 200; (codes[0] != 200 && codes[1] != 200) || (other != 409 && other != 404) {
		t.Fatalf("two couple invitations accepted at once: %v", codes)
	}
	var couples int64
	e.svc.DB.Model(&model.SpaceMember{}).Where("user_id = ? AND couple", xavierID).Count(&couples)
	if couples != 1 {
		t.Fatalf("xavier is in %d couple spaces", couples)
	}

	g := id(e.must(200, "POST", "/spaces", alice, map[string]any{"type": "friends"}).obj(t))
	for i := 0; i < 8; i++ {
		e.join(g, alice, "bob", bob)
		trip := id(e.must(200, "POST", "/trips", bob, map[string]any{"title": fmt.Sprintf("第%d次", i)}).obj(t))
		rc := make([]int, 2)
		parallel(2, func(j int) {
			if j == 0 {
				rc[j] = e.status("PATCH", fmt.Sprintf("/trips/%d", trip), bob, map[string]any{"space_id": g})
			} else {
				rc[j] = e.status("DELETE", fmt.Sprintf("/spaces/%d/members/%d", g, bobID), alice, nil)
			}
		})
		var linked int64
		e.svc.DB.Model(&model.Trip{}).Where("id = ? AND space_id IS NOT NULL", trip).Count(&linked)
		if linked != 0 || rc[1] != 200 || (rc[0] != 200 && rc[0] != 404) {
			t.Fatalf("round %d: bob's trip stayed in the space he left: %d (link %d, removal %d)", i, linked, rc[0], rc[1])
		}
		e.must(404, "GET", fmt.Sprintf("/trips/%d", trip), alice, nil)
	}
}
