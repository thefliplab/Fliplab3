-- FlipLab 3.0 — one-time data cleanup.
-- RUN ONLY AFTER THE FINAL export3 COPY FROM 2.0 (a re-copy would bring the old data back).
-- Decisions by Steve, Oct 31 2026. Safe to run twice (second run changes nothing).

begin;

-- 1. Merge duplicate students: (keep, merge) — everything on the merge record moves to the keep record
create temp table dup_map (keep text, dup text) on commit drop;
insert into dup_map values
  ('STU039',            'STU1777822781900'),   -- Eleanor Hendy (keep the Active record)
  ('STU1778120226570',  'STU1779220094395'),   -- Maggie Partin
  ('STU1777942787704',  'STU1778464615363'),   -- Penelope Alford (same kid; Kady Bitter kept as 2nd contact)
  ('STU1776613403495',  'STU1775432883421_7'), -- Piper Pritchard (keep the record with birthday + level)
  ('STU1777946312837',  'STU1782225730080');   -- Casey Hardin (birthday Apr 1 2016 is right)
delete from dup_map m where not exists (select 1 from students where id = m.dup);  -- already merged

-- Penelope: keep Kady as a second contact, and the newer skill level
update students k set
  extra = k.extra || jsonb_build_object('SecondParentName', d.parent_name, 'SecondParentPhone', d.parent_phone, 'SecondParentEmail', d.parent_email),
  skill_level = coalesce(d.skill_level, k.skill_level)
from students d
where k.id = 'STU1777942787704' and d.id = 'STU1778464615363';
-- Casey: newer record's status (Dropped)
update students k set status = d.status, active = d.active
from students d where k.id = 'STU1777946312837' and d.id = 'STU1782225730080';

update attendance         t set student_id = m.keep from dup_map m where t.student_id = m.dup;
update class_attendance   t set student_id = m.keep from dup_map m where t.student_id = m.dup;
update class_enrollments  t set student_id = m.keep from dup_map m where t.student_id = m.dup;
update payments           t set student_id = m.keep from dup_map m where t.student_id = m.dup;
update private_lessons    t set student_id = m.keep from dup_map m where t.student_id = m.dup;
update schedule_exceptions t set student_id = m.keep from dup_map m where t.student_id = m.dup;
update text_log           t set student_id = m.keep from dup_map m where t.student_id = m.dup;
update waitlist           t set student_id = m.keep from dup_map m where t.student_id = m.dup;
delete from student_skills t using dup_map m where t.student_id = m.dup
  and exists (select 1 from student_skills k where k.student_id = m.keep and k.skill_id = t.skill_id);
update student_skills     t set student_id = m.keep from dup_map m where t.student_id = m.dup;
delete from students s using dup_map m where s.id = m.dup;

-- 2. Shared lessons still stored at the old $40 → regular $30 (Mallory $20, Zoey $25, Madison $30 left as-is)
update private_lessons set price = '$30'
where lesson_type = 'Shared' and price = '$40' and coalesce(duration, '30 min') = '30 min'
  and (end_date is null or end_date > current_date);

-- 3. One waitlist status: "Waiting" → "Waitlist"
update waitlist set status = 'Waitlist' where status = 'Waiting';

-- 4. Active but never coming back (Steve, Oct 31): Stella Turner, Lily Braun → Inactive
--    (Lilah Grace, Emma Ohmer, Riley Stahl stay Active with no lesson booked)
update students set status = 'Inactive', active = false where id in ('STU019', 'STU1775432882917_4') and status = 'Active';

-- 5. Moved from Drop-In to Waitlist (Steve, Oct 31): Lucy Curington, Josie Vaccari, Sabol Thompson, Aurora Pendergraft, Kinley DeVore
update students set status = 'Waitlist'
  where id in ('STU1784582401244', 'STU1781180024360', 'STU1786384060445', 'STU1786477195830', 'STU1780344777406');
update waitlist set status = 'Waitlist'
  where student_id in ('STU1784582401244', 'STU1781180024360', 'STU1786384060445', 'STU1786477195830', 'STU1780344777406')
    and status in ('Drop-In', 'Waiting');

-- 6. Old skill level names → L1–L6 (Steve, Oct 31)
with m(o, n) as (values ('Level Beginner 3','L3-Building'), ('Level Advanced 3','L4-Progressing'), ('Level 1/2','L1-Foundations'),
                        ('Level 4','L4-Progressing'), ('Level 5','L5-Advanced'), ('Level 6','L6-Elite'))
update students t set skill_level = m.n from m where t.skill_level = m.o;
with m(o, n) as (values ('Level Beginner 3','L3-Building'), ('Level Advanced 3','L4-Progressing'), ('Level 1/2','L1-Foundations'),
                        ('Level 4','L4-Progressing'), ('Level 5','L5-Advanced'), ('Level 6','L6-Elite'))
update waitlist t set skill_level = m.n from m where t.skill_level = m.o;

-- 7. Old "Emma Jackson" coach setup (Steve, Nov 1 — he re-adds Emma as a new coach in 3.0)
--    Removes the old coach entry and the Sunday 12:00 PM lesson (+ its week changes).
--    Keeps Emma the student (STU006), her other lessons, payments and attendance.
delete from schedule_exceptions where lesson_id = 'PL-1788970282640';
delete from private_lessons where id = 'PL-1788970282640';
delete from coaches where id = 'C1789822214285';

-- 8. Old coaches (Steve, Nov 1): Coach Lexi and test coach — no lessons
delete from coaches where id in ('C1773883432705', 'C1774599806937');

-- 9. Phone numbers → (513) 555-1234 layout (Steve, Nov 1). Only 10-digit numbers (or 11 starting with 1); others left alone.
create or replace function pg_temp.fmt_phone(p text) returns text language sql as $$
  select case when d ~ '^1?[0-9]{10}$' then '(' || substr(right(d,10),1,3) || ') ' || substr(right(d,10),4,3) || '-' || substr(right(d,10),7,4) else p end
  from (select regexp_replace(coalesce(p,''), '[^0-9]', '', 'g') d) x $$;
update students set parent_phone = pg_temp.fmt_phone(parent_phone) where parent_phone is not null;
update students set emergency_phone = pg_temp.fmt_phone(emergency_phone) where emergency_phone is not null;
update coaches set phone = pg_temp.fmt_phone(phone) where phone is not null;
update waitlist set parent_phone = pg_temp.fmt_phone(parent_phone) where parent_phone is not null;

-- 10. Penny Taylor Sunday 12:30 PM with Coach Steve is Solo (Steve, Nov 1) — 2.0 had it as Shared with no partner.
--     Runs after step 2, so its $40 → $30 shared change is undone here.
update private_lessons set lesson_type = 'Solo', share_type = 'No', price = '$40' where id = 'PL-1788970306229';

-- 11. Coach Steve's cell is (234) 817-7491 (Steve, Nov 1) — used for claim alerts and test texts.
update coaches set phone = '(234) 817-7491' where id = 'C1773883337653';

-- 12. Birthdates / levels typed into 3.0 before switch-over (Missing info pop-up saves them to keep_fixes too).
--     The final copy overwrites them, so put back the latest value for each kid + field.
with k as (select distinct on (tbl, row_id, field) tbl, row_id, field, value from keep_fixes order by tbl, row_id, field, created_at desc)
update students t set dob = k.value::date from k where k.tbl = 'students' and k.field = 'dob' and t.id = k.row_id;
with k as (select distinct on (tbl, row_id, field) tbl, row_id, field, value from keep_fixes order by tbl, row_id, field, created_at desc)
update students t set skill_level = k.value from k where k.tbl = 'students' and k.field = 'skill_level' and t.id = k.row_id;
with k as (select distinct on (tbl, row_id, field) tbl, row_id, field, value from keep_fixes order by tbl, row_id, field, created_at desc)
update waitlist t set dob = k.value::date from k where k.tbl = 'waitlist' and k.field = 'dob' and t.id::text = k.row_id;
with k as (select distinct on (tbl, row_id, field) tbl, row_id, field, value from keep_fixes order by tbl, row_id, field, created_at desc)
update waitlist t set skill_level = k.value from k where k.tbl = 'waitlist' and k.field = 'skill_level' and t.id::text = k.row_id;

-- 13. Grace Gerke + Paisley Padgett paired Tue 8:30 PM with Coach Steve (done in 3.0 Nov 1; 2.0 has them unpaired).
--     Same values 3.0 had on Nov 3 (the shared price is applied by the app when both are in the slot).
update private_lessons set pair_id = 'PAIR-GG-PP-TUE830', share_type = 'Matched' where id in ('PV163', 'PL-1792546158511');
update private_lessons set lesson_type = 'Shared', price = '$30' where id = 'PL-1792546158511';

-- 14. Loveland 4th Grade Clinic (SCH-002, June 7) → a one-time clinic under Classes → Past clinics (Steve, Nov 3).
--     Its 23 kids move into clinic_kids. Paid = they have a 2.0 class payment; amount = what they paid.
--     The 20 payments ($280, lesson_id CLS_SCH-002_…) stay as they are — NO new payments, so the money isn't counted twice.
--     Jane Insco (real student) stays linked to her student record; the other 22 student records are already Inactive and are left alone.
insert into clinic_kids (gym_id, schedule_id, kid_name, parent_name, phone, email, paid, amount, student_id, notes)
select e.gym_id, e.schedule_id, e.student_name, e.parent_name, e.phone, e.email,
       coalesce(p.amt, 0) > 0, coalesce(p.amt, 14),
       case when exists (select 1 from private_lessons l where l.student_id = e.student_id)
              or exists (select 1 from class_enrollments e2 where e2.student_id = e.student_id and e2.schedule_id <> 'SCH-002')
            then e.student_id end,
       'Moved from 2.0 class enrollment'
from class_enrollments e
left join (select split_part(lesson_id, '_', 3) sid, sum(amount) amt from payments where lesson_id like 'CLS\_SCH-002\_%' group by 1) p on p.sid = e.student_id
where e.schedule_id = 'SCH-002';
delete from class_enrollments where schedule_id = 'SCH-002';
update class_schedule set kind = 'clinic', clinic_date = '2026-06-07', ended_at = now(), active = false where id = 'SCH-002';

commit;
