import type { JsonSchema } from "@aaply/action-contract";
import type { SqlConnectorDefinition } from "@aaply/connect";

/** A booking database: slots, bookings by business reference, and its declared SQL connector. */
export const BOOKING_SCHEMA = `
CREATE SCHEMA booking;
CREATE TABLE booking.slots (id text PRIMARY KEY, starts_at timestamptz NOT NULL);
CREATE TABLE booking.bookings (
  id serial PRIMARY KEY,
  slot_id text NOT NULL REFERENCES booking.slots (id),
  customer_ref text NOT NULL,
  reference text NOT NULL UNIQUE,
  status text NOT NULL DEFAULT 'booked'
);
CREATE UNIQUE INDEX bookings_one_per_slot ON booking.bookings (slot_id) WHERE status = 'booked';
INSERT INTO booking.slots VALUES ('s1', '2026-11-02T09:00:00Z'), ('s2', '2026-11-02T10:00:00Z'), ('s3', '2026-11-02T11:00:00Z');
CREATE ROLE booking_app LOGIN PASSWORD 'booking-pw';
GRANT USAGE ON SCHEMA booking TO booking_app;
GRANT SELECT ON booking.slots TO booking_app;
GRANT SELECT, INSERT, UPDATE ON booking.bookings TO booking_app;
GRANT USAGE ON SEQUENCE booking.bookings_id_seq TO booking_app;
-- A tenant's database may read strings the old way: Connect must not depend on how.
ALTER ROLE booking_app SET standard_conforming_strings = off;
`;

const bookingOutput = (): JsonSchema => ({ type: "object", required: ["id", "status"], properties: { id: { type: "integer" }, status: { type: "string" } } });

/** `cancelTag` changes the undo's statement text (so its pin), not what it does. */
export function bookingConnector(version = "1.0.0", findOrder = "starts_at", cancelTag = ""): SqlConnectorDefinition {
  return {
    id: "booking-db",
    version,
    title: "Booking database",
    kind: "sql",
    engine: "postgres",
    operations: {
      freeSlots: {
        title: "Free slots",
        effect: "read",
        statement: `select s.id, s.starts_at from booking.slots s where not exists (select 1 from booking.bookings b where b.slot_id = s.id and b.status = 'booked') order by ${findOrder}`,
        params: [],
        rows: "many",
        maxRows: 50,
        input: { type: "object" },
        output: { type: "object", required: ["rows"], properties: { rows: { type: "array", items: { type: "object", properties: { id: { type: "string" }, starts_at: { type: "string" } } } } } },
      },
      createBooking: {
        title: "Create a booking",
        effect: "write",
        idempotent: true,
        riskFloor: "confirm",
        compensate: "cancelBooking",
        statement: "insert into booking.bookings (slot_id, customer_ref, reference) values ($1, $2, $3) on conflict (reference) do nothing returning id, status",
        params: ["slotId", "customerRef", "reference"],
        rows: "one",
        onConflictEmpty: { statement: "select id, status from booking.bookings where reference = $1 and slot_id = $2 and customer_ref = $3", params: ["reference", "slotId", "customerRef"] },
        errors: { "23505": "booking/slot-taken", "23503": "booking/no-such-slot" },
        input: {
          type: "object",
          required: ["slotId", "customerRef", "reference"],
          properties: { slotId: { type: "string" }, customerRef: { type: "string" }, reference: { type: "string", minLength: 8 } },
        },
        output: bookingOutput(),
      },
      cancelBooking: {
        title: "Cancel a booking",
        effect: "write",
        idempotent: true,
        statement: `update booking.bookings set status = 'cancelled' where reference = $1 returning id, status${cancelTag ? ` /* ${cancelTag} */` : ""}`,
        params: ["reference"],
        rows: "one",
        input: { type: "object", required: ["reference"], properties: { reference: { type: "string" }, slotId: { type: "string" }, customerRef: { type: "string" } } },
        output: bookingOutput(),
      },
      sneakyRead: {
        title: "A read that tries to write",
        effect: "read",
        statement: "with gone as (update booking.bookings set status = 'gone' returning id) select count(*)::int as n from gone",
        params: [],
        rows: "one",
        input: { type: "object" },
        output: { type: "object" },
      },
      slowBooking: {
        title: "Book, slowly",
        effect: "write",
        idempotent: true,
        statement: "insert into booking.bookings (slot_id, customer_ref, reference) select $1, $2, $3 from pg_sleep(1.5) returning id, status",
        params: ["slotId", "customerRef", "reference"],
        rows: "one",
        input: { type: "object", required: ["slotId", "customerRef", "reference"], properties: { slotId: { type: "string" }, customerRef: { type: "string" }, reference: { type: "string" } } },
        output: bookingOutput(),
      },
      stacked: {
        title: "A read that hides a second statement",
        effect: "read",
        statement: "select '\\' , '; commit; insert into booking.slots values (''s9'', now()); select 1 --' as x",
        params: [],
        rows: "one",
        input: { type: "object" },
        output: { type: "object" },
      },
      huge: {
        title: "Too much to read",
        effect: "read",
        statement: "select repeat('x', 6000000) as x",
        params: [],
        rows: "one",
        input: { type: "object" },
        output: { type: "object" },
      },
      holdLock: {
        title: "Leaves a session lock",
        effect: "read",
        statement: "select pg_advisory_lock(7)::text as locked",
        params: [],
        rows: "one",
        input: { type: "object" },
        output: { type: "object" },
      },
      slotDay: {
        title: "A slot's day",
        effect: "read",
        statement: "select (starts_at at time zone 'UTC')::date as day, (starts_at at time zone 'UTC') as local from booking.slots where id = $1",
        params: ["id"],
        rows: "one",
        input: { type: "object", required: ["id"], properties: { id: { type: "string" } } },
        output: { type: "object", properties: { day: { type: "string" }, local: { type: "string" } } },
      },
      slow: {
        title: "Slow",
        effect: "read",
        statement: "select pg_sleep(30) is null as slept",
        params: [],
        rows: "one",
        input: { type: "object" },
        output: { type: "object" },
      },
    },
  };
}
