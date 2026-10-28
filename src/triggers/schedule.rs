use chrono::{DateTime, Datelike, Duration, LocalResult, NaiveDate, NaiveDateTime, TimeZone};

const FORMS: &str = "\"daily 09:00\", \"weekdays 09:00\", \"every 4h\" or \"cron 30 9 * * 1-5\"";
// A slot that never comes within this many days is refused when the schedule is read.
const HORIZON_DAYS: i64 = 4 * 366;
// The longest spring-forward gap any time zone has.
const GAP_MINUTES: i64 = 180;
const MISSED_MAX: usize = 500;

#[derive(Debug, Clone, PartialEq)]
pub struct Schedule {
    text: String,
    minutes: Vec<u32>,
    hours: Vec<u32>,
    days: Vec<u32>,
    months: Vec<u32>,
    weekdays: Vec<u32>,
    days_named: bool,
    weekdays_named: bool,
}

#[derive(Debug, Clone, PartialEq)]
pub struct Due<Tz: TimeZone> {
    pub latest: DateTime<Tz>,
    pub missed: usize,
}

impl Schedule {
    pub fn parse(text: &str) -> Result<Schedule, String> {
        let words: Vec<&str> = text.split_whitespace().collect();
        let fail = |why: &str| Err(format!("schedule {text:?} {why}. Write it as {FORMS}"));
        let cron = match words.as_slice() {
            ["daily", at] => {
                let Some((h, m)) = clock(at) else {
                    return fail("has a time that is not HH:MM");
                };
                format!("{m} {h} * * *")
            }
            ["weekdays", at] => {
                let Some((h, m)) = clock(at) else {
                    return fail("has a time that is not HH:MM");
                };
                format!("{m} {h} * * 1-5")
            }
            ["every", n] | ["every", n, "hours" | "hour" | "h"] => {
                let n = n.strip_suffix('h').unwrap_or(n);
                match n.parse::<u32>() {
                    Ok(n) if (1..=23).contains(&n) => format!("0 */{n} * * *"),
                    _ => return fail("needs a number of hours from 1 to 23"),
                }
            }
            ["cron", fields @ ..] if fields.len() == 5 => fields.join(" "),
            ["cron", ..] => return fail("needs five cron fields"),
            _ => return fail("is not a schedule Yardbell knows"),
        };
        let fields: Vec<&str> = cron.split(' ').collect();
        let parsed = (|| -> Result<Schedule, String> {
            let weekdays = field(fields[4], 0, 7, "day of the week")?
                .into_iter()
                .map(|d| d % 7)
                .collect::<std::collections::BTreeSet<_>>()
                .into_iter()
                .collect();
            Ok(Schedule {
                text: words.join(" "),
                minutes: field(fields[0], 0, 59, "minute")?,
                hours: field(fields[1], 0, 23, "hour")?,
                days: field(fields[2], 1, 31, "day of the month")?,
                months: field(fields[3], 1, 12, "month")?,
                weekdays,
                days_named: !fields[2].starts_with('*'),
                weekdays_named: !fields[4].starts_with('*'),
            })
        })();
        let schedule = match parsed {
            Ok(s) => s,
            Err(why) => return fail(&why),
        };
        let start = NaiveDate::from_ymd_opt(2024, 1, 1).expect("a real date");
        if !(0..HORIZON_DAYS).any(|i| schedule.on(start + Duration::days(i))) {
            return fail("names a day that never comes");
        }
        Ok(schedule)
    }

    pub fn text(&self) -> &str {
        &self.text
    }

    fn on(&self, date: NaiveDate) -> bool {
        if !self.months.contains(&date.month()) {
            return false;
        }
        let day = self.days.contains(&date.day());
        let weekday = self
            .weekdays
            .contains(&date.weekday().num_days_from_sunday());
        // Cron's own rule: when both fields name days, either one is enough.
        if self.days_named && self.weekdays_named {
            day || weekday
        } else {
            day && weekday
        }
    }

    // The first slot strictly after the given moment, in that moment's time zone. A slot in the
    // hour the clocks skip runs when they jump, and a slot in the hour they repeat runs the first
    // time round only.
    pub fn next_after<Tz: TimeZone>(&self, after: &DateTime<Tz>) -> Option<DateTime<Tz>> {
        let tz = after.timezone();
        let mut date = after.naive_local().date() - Duration::days(1);
        for _ in 0..HORIZON_DAYS {
            if self.on(date) {
                for h in &self.hours {
                    for m in &self.minutes {
                        let naive = date.and_hms_opt(*h, *m, 0).expect("a real time");
                        if let Some(at) = resolve(&tz, naive).filter(|at| at > after) {
                            return Some(at);
                        }
                    }
                }
            }
            date += Duration::days(1);
        }
        None
    }

    // Every slot after the anchor up to now counts as one: the latest is what runs.
    pub fn due<Tz: TimeZone>(&self, anchor: &DateTime<Tz>, now: &DateTime<Tz>) -> Option<Due<Tz>> {
        let mut latest = self.next_after(anchor).filter(|at| at <= now)?;
        let mut missed = 1;
        while missed < MISSED_MAX {
            match self.next_after(&latest).filter(|at| at <= now) {
                Some(at) => {
                    latest = at;
                    missed += 1;
                }
                None => break,
            }
        }
        Some(Due { latest, missed })
    }

    pub fn describe(&self) -> String {
        let words: Vec<&str> = self.text.split(' ').collect();
        match words.as_slice() {
            ["daily", at] => format!("Daily at {}", padded(at)),
            ["weekdays", at] => format!("Weekdays at {}", padded(at)),
            ["every", n, ..] => match n.trim_end_matches('h') {
                "1" => "Every hour".into(),
                n => format!("Every {n} hours from midnight"),
            },
            _ => format!("Cron {}", words[1..].join(" ")),
        }
    }
}

fn padded(at: &str) -> String {
    clock(at).map_or_else(|| at.to_string(), |(h, m)| format!("{h:02}:{m:02}"))
}

fn clock(text: &str) -> Option<(u32, u32)> {
    let (h, m) = text.split_once(':')?;
    if h.is_empty() || h.len() > 2 || m.len() != 2 {
        return None;
    }
    let (h, m) = (h.parse().ok()?, m.parse().ok()?);
    (h < 24 && m < 60).then_some((h, m))
}

fn number(text: &str, min: u32, max: u32, what: &str) -> Result<u32, String> {
    match text.parse::<u32>() {
        Ok(n) if (min..=max).contains(&n) => Ok(n),
        Ok(n) => Err(format!("has {what} {n}, outside {min} to {max}")),
        Err(_) => Err(format!("has {text:?} where a {what} should be")),
    }
}

fn field(text: &str, min: u32, max: u32, what: &str) -> Result<Vec<u32>, String> {
    let mut out = std::collections::BTreeSet::new();
    for part in text.split(',') {
        let (range, step) = match part.split_once('/') {
            Some((range, step)) => match step.parse::<u32>() {
                Ok(step) if step > 0 => (range, step),
                _ => {
                    return Err(format!(
                        "has a step {step:?} in the {what}, it must be 1 or more"
                    ))
                }
            },
            None => (part, 1),
        };
        let (from, to) = match range {
            "*" => (min, max),
            _ => match range.split_once('-') {
                Some((a, b)) => (number(a, min, max, what)?, number(b, min, max, what)?),
                None => {
                    let n = number(range, min, max, what)?;
                    (n, if part.contains('/') { max } else { n })
                }
            },
        };
        if from > to {
            return Err(format!("has a {what} range {range} that runs backwards"));
        }
        out.extend((from..=to).step_by(step as usize));
    }
    Ok(out.into_iter().collect())
}

fn resolve<Tz: TimeZone>(tz: &Tz, naive: NaiveDateTime) -> Option<DateTime<Tz>> {
    match tz.from_local_datetime(&naive) {
        LocalResult::Single(at) => Some(at),
        LocalResult::Ambiguous(a, b) => Some(if a < b { a } else { b }),
        LocalResult::None => (1..=GAP_MINUTES).find_map(|m| {
            tz.from_local_datetime(&(naive + Duration::minutes(m)))
                .earliest()
        }),
    }
}

#[cfg(test)]
pub(crate) mod tests {
    use super::*;
    use chrono::{FixedOffset, NaiveDate, Offset, Utc};

    // Europe/London in 2026: the clocks go forward at 01:00 UTC on 29 March and back at 01:00 UTC
    // on 25 October.
    #[derive(Debug, Clone, Copy, PartialEq, Eq)]
    pub(crate) struct London;

    fn summer(utc: &NaiveDateTime) -> bool {
        let start = NaiveDate::from_ymd_opt(2026, 3, 29)
            .unwrap()
            .and_hms_opt(1, 0, 0)
            .unwrap();
        let end = NaiveDate::from_ymd_opt(2026, 10, 25)
            .unwrap()
            .and_hms_opt(1, 0, 0)
            .unwrap();
        *utc >= start && *utc < end
    }

    impl TimeZone for London {
        type Offset = FixedOffset;

        fn from_offset(_: &FixedOffset) -> London {
            London
        }

        fn offset_from_local_date(&self, local: &NaiveDate) -> LocalResult<FixedOffset> {
            self.offset_from_local_datetime(&local.and_hms_opt(12, 0, 0).unwrap())
        }

        fn offset_from_local_datetime(&self, local: &NaiveDateTime) -> LocalResult<FixedOffset> {
            let fits: Vec<FixedOffset> = [3600, 0]
                .into_iter()
                .map(|secs| FixedOffset::east_opt(secs).unwrap())
                .filter(|o| {
                    self.offset_from_utc_datetime(
                        &(*local - Duration::seconds(o.local_minus_utc().into())),
                    ) == *o
                })
                .collect();
            match fits.as_slice() {
                [] => LocalResult::None,
                [one] => LocalResult::Single(*one),
                [a, b, ..] => LocalResult::Ambiguous(*a, *b),
            }
        }

        fn offset_from_utc_date(&self, utc: &NaiveDate) -> FixedOffset {
            self.offset_from_utc_datetime(&utc.and_hms_opt(12, 0, 0).unwrap())
        }

        fn offset_from_utc_datetime(&self, utc: &NaiveDateTime) -> FixedOffset {
            FixedOffset::east_opt(if summer(utc) { 3600 } else { 0 }).unwrap()
        }
    }

    pub(crate) fn london(y: i32, mo: u32, d: u32, h: u32, mi: u32) -> DateTime<London> {
        London
            .from_local_datetime(
                &NaiveDate::from_ymd_opt(y, mo, d)
                    .unwrap()
                    .and_hms_opt(h, mi, 0)
                    .unwrap(),
            )
            .earliest()
            .unwrap()
    }

    fn utc(at: &DateTime<London>) -> String {
        at.with_timezone(&Utc).format("%m-%d %H:%M").to_string()
    }

    fn slots(s: &str, from: DateTime<London>, count: usize) -> Vec<String> {
        let schedule = Schedule::parse(s).unwrap();
        let mut at = from;
        (0..count)
            .map(|_| {
                at = schedule.next_after(&at).unwrap();
                format!("{} {}", at.format("%a %m-%d %H:%M"), at.offset().fix())
            })
            .collect()
    }

    #[test]
    fn the_four_forms_are_read_and_described() {
        for (text, said) in [
            ("daily 09:00", "Daily at 09:00"),
            ("daily 9:05", "Daily at 09:05"),
            ("weekdays 08:30", "Weekdays at 08:30"),
            ("every 4h", "Every 4 hours from midnight"),
            ("every 1 hour", "Every hour"),
            ("cron 30 9 * * 1-5", "Cron 30 9 * * 1-5"),
            ("  cron  */15  *  1,15  *  * ", "Cron */15 * 1,15 * *"),
        ] {
            assert_eq!(Schedule::parse(text).unwrap().describe(), said, "{text}");
        }
        for (bad, why) in [
            ("daily 25:00", "not HH:MM"),
            ("daily 9", "not HH:MM"),
            ("daily 09:0", "not HH:MM"),
            ("hourly", "not a schedule"),
            ("every 0h", "from 1 to 23"),
            ("every 24h", "from 1 to 23"),
            ("cron 0 9 * *", "five cron fields"),
            ("cron 60 9 * * *", "minute 60, outside 0 to 59"),
            ("cron 0 9 * * 8", "day of the week 8"),
            ("cron 0 9 * JAN *", "\"JAN\" where a month"),
            ("cron 0 9 5-1 * *", "runs backwards"),
            ("cron */0 * * * *", "step \"0\""),
            ("cron 0 0 31 2 *", "never comes"),
            ("cron 0 0 30 2 *", "never comes"),
            ("", "not a schedule"),
        ] {
            let err = Schedule::parse(bad).unwrap_err();
            assert!(err.contains(why), "{bad}: {err}");
            assert!(err.contains("every 4h"), "{err}");
        }
        assert!(
            Schedule::parse("cron 0 0 29 2 *").is_ok(),
            "a leap day comes"
        );
        assert!(Schedule::parse("cron 0 9 * * 7").is_ok(), "7 is Sunday too");
    }

    #[test]
    fn daily_weekday_and_hourly_slots() {
        assert_eq!(
            slots("daily 09:00", london(2026, 1, 9, 9, 0), 2),
            ["Sat 01-10 09:00 +00:00", "Sun 01-11 09:00 +00:00"],
            "the slot at the anchor itself has run"
        );
        assert_eq!(
            slots("weekdays 08:30", london(2026, 1, 9, 8, 31), 2),
            ["Mon 01-12 08:30 +00:00", "Tue 01-13 08:30 +00:00"]
        );
        assert_eq!(
            slots("every 5h", london(2026, 1, 9, 21, 0), 3),
            [
                "Sat 01-10 00:00 +00:00",
                "Sat 01-10 05:00 +00:00",
                "Sat 01-10 10:00 +00:00"
            ],
            "counted from midnight, so 20:00 is followed by 00:00"
        );
        assert_eq!(
            slots("daily 23:59", london(2026, 12, 31, 23, 58), 2),
            ["Thu 12-31 23:59 +00:00", "Fri 01-01 23:59 +00:00"],
            "across the new year"
        );
        assert_eq!(
            slots("cron 0 12 29 2 *", london(2026, 1, 1, 0, 0), 1),
            ["Tue 02-29 12:00 +00:00"],
            "the next leap day is in 2028"
        );
    }

    #[test]
    fn cron_days_match_either_the_date_or_the_weekday() {
        assert_eq!(
            slots("cron 0 6 13 * 5", london(2026, 2, 1, 0, 0), 3),
            [
                "Fri 02-06 06:00 +00:00",
                "Fri 02-13 06:00 +00:00",
                "Fri 02-20 06:00 +00:00"
            ]
        );
        assert_eq!(
            slots("cron 0 6 13 * *", london(2026, 2, 1, 0, 0), 1),
            ["Fri 02-13 06:00 +00:00"]
        );
        assert_eq!(
            slots("cron 0 6 */10 * *", london(2026, 2, 1, 6, 0), 3),
            [
                "Wed 02-11 06:00 +00:00",
                "Sat 02-21 06:00 +00:00",
                "Sun 03-01 06:00 +00:00"
            ]
        );
    }

    #[test]
    fn a_slot_in_the_skipped_hour_runs_when_the_clocks_jump() {
        assert_eq!(
            slots("daily 01:30", london(2026, 3, 28, 12, 0), 2),
            ["Sun 03-29 02:00 +01:00", "Mon 03-30 01:30 +01:00"]
        );
        let at = Schedule::parse("daily 01:30")
            .unwrap()
            .next_after(&london(2026, 3, 28, 12, 0))
            .unwrap();
        assert_eq!(utc(&at), "03-29 01:00");
        assert_eq!(
            slots("every 1h", london(2026, 3, 29, 0, 0), 3),
            [
                "Sun 03-29 02:00 +01:00",
                "Sun 03-29 03:00 +01:00",
                "Sun 03-29 04:00 +01:00"
            ],
            "01:00 does not exist and 02:00 is the jump itself, so it runs once"
        );
        assert_eq!(
            slots("daily 09:00", london(2026, 3, 28, 9, 0), 2),
            ["Sun 03-29 09:00 +01:00", "Mon 03-30 09:00 +01:00"],
            "the day after is 23 hours long and the wall clock time stays"
        );
    }

    #[test]
    fn a_slot_in_the_repeated_hour_runs_once() {
        assert_eq!(
            slots("daily 01:30", london(2026, 10, 24, 12, 0), 2),
            ["Sun 10-25 01:30 +01:00", "Mon 10-26 01:30 +00:00"]
        );
        let first = Schedule::parse("daily 01:30")
            .unwrap()
            .next_after(&london(2026, 10, 24, 12, 0))
            .unwrap();
        assert_eq!(utc(&first), "10-25 00:30");
        let second_time_round = first + Duration::hours(1);
        assert_eq!(second_time_round.format("%H:%M").to_string(), "01:30");
        let next = Schedule::parse("daily 01:30")
            .unwrap()
            .next_after(&second_time_round)
            .unwrap();
        assert_eq!(utc(&next), "10-26 01:30", "not again in the repeated hour");
        assert_eq!(
            slots("every 1h", london(2026, 10, 25, 0, 0), 3),
            [
                "Sun 10-25 01:00 +01:00",
                "Sun 10-25 02:00 +00:00",
                "Sun 10-25 03:00 +00:00"
            ]
        );
    }

    #[test]
    fn missed_slots_add_up_to_one_run_at_the_latest() {
        let s = Schedule::parse("daily 09:00").unwrap();
        let anchor = london(2026, 1, 5, 12, 0);
        assert_eq!(s.due(&anchor, &london(2026, 1, 6, 8, 59)), None);
        let due = s.due(&anchor, &london(2026, 1, 6, 9, 0)).unwrap();
        assert_eq!((due.latest, due.missed), (london(2026, 1, 6, 9, 0), 1));
        let due = s.due(&anchor, &london(2026, 1, 9, 10, 0)).unwrap();
        assert_eq!((due.latest, due.missed), (london(2026, 1, 9, 9, 0), 4));
        assert_eq!(s.due(&due.latest, &london(2026, 1, 9, 23, 0)), None);
        let hourly = Schedule::parse("every 1h").unwrap();
        let long = hourly
            .due(&london(2026, 1, 1, 0, 0), &london(2026, 12, 1, 0, 0))
            .unwrap();
        assert_eq!(long.missed, MISSED_MAX, "counting stops, one run still");
    }
}
