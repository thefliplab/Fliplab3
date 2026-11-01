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

commit;
