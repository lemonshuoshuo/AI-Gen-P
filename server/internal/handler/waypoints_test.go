package handler

import (
	"reflect"
	"testing"
	"time"

	"gorm.io/gorm/schema"

	"triphub/internal/model"
)

// Every editable waypoint column must be written when an edit changes it
// (saveWaypointChanges only writes the columns changedWaypointColumns lists).
func TestChangedWaypointColumns(t *testing.T) {
	notEditable := map[string]bool{"ID": true, "TripID": true, "Seq": true, "CreatedByID": true, "CreatedAt": true, "UpdatedAt": true}
	naming := schema.NamingStrategy{}
	typ := reflect.TypeOf(model.Waypoint{})
	for i := 0; i < typ.NumField(); i++ {
		f := typ.Field(i)
		if notEditable[f.Name] {
			continue
		}
		var a, b model.Waypoint
		v := reflect.ValueOf(&b).Elem().Field(i)
		switch v.Kind() {
		case reflect.String:
			v.SetString("x")
		case reflect.Int, reflect.Int64:
			v.SetInt(1)
		case reflect.Float64:
			v.SetFloat(1)
		case reflect.Bool:
			v.SetBool(true)
		case reflect.Pointer:
			v.Set(reflect.New(f.Type.Elem()))
		default:
			t.Fatalf("field %s: unhandled kind %s", f.Name, v.Kind())
		}
		if got, want := changedWaypointColumns(&a, &b), naming.ColumnName("", f.Name); len(got) != 1 || got[0] != want {
			t.Errorf("changing %s: columns %v, want [%s]", f.Name, got, want)
		}
	}
	// The same instant in another zone, or the same place ID at another address, is no change.
	at := time.Date(2026, 5, 1, 9, 0, 0, 0, time.UTC)
	bj := at.In(time.FixedZone("CST", 8*3600))
	p1, p2 := int64(8), int64(8)
	a := model.Waypoint{ArrivedAt: &at, PlaceID: &p1}
	b := model.Waypoint{ArrivedAt: &bj, PlaceID: &p2}
	if got := changedWaypointColumns(&a, &b); len(got) != 0 {
		t.Errorf("equal values: columns %v", got)
	}
}
