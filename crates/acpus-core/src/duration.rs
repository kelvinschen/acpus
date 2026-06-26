use thiserror::Error;

const MAX_SAFE_DURATION_MS: u64 = 9_007_199_254_740_991;

#[derive(Clone, Debug, Error, PartialEq, Eq)]
pub enum ParseDurationError {
    #[error("Invalid duration '{0}'. Use ms, s, m, or h.")]
    Invalid(String),
    #[error("duration must be at least {0}ms")]
    BelowMinimum(u64),
}

pub fn parse_duration_ms(input: &str, min_ms: Option<u64>) -> Result<u64, ParseDurationError> {
    let s = input.trim();
    if s.is_empty() {
        return Err(ParseDurationError::Invalid(input.to_string()));
    }
    let (number, multiplier) = if let Some(v) = s.strip_suffix("ms") {
        (v, 1)
    } else if let Some(v) = s.strip_suffix('s') {
        (v, 1_000)
    } else if let Some(v) = s.strip_suffix('m') {
        (v, 60_000)
    } else if let Some(v) = s.strip_suffix('h') {
        (v, 3_600_000)
    } else {
        (s, 1)
    };
    if number.is_empty() || !number.bytes().all(|byte| byte.is_ascii_digit()) {
        return Err(ParseDurationError::Invalid(input.to_string()));
    }
    let parsed = number
        .parse::<u64>()
        .map_err(|_| ParseDurationError::Invalid(input.to_string()))?
        .checked_mul(multiplier)
        .ok_or_else(|| ParseDurationError::Invalid(input.to_string()))?;
    if parsed > MAX_SAFE_DURATION_MS {
        return Err(ParseDurationError::Invalid(input.to_string()));
    }
    if let Some(min) = min_ms
        && parsed < min
    {
        return Err(ParseDurationError::BelowMinimum(min));
    }
    Ok(parsed)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_supported_units() {
        assert_eq!(parse_duration_ms("500ms", None).unwrap(), 500);
        assert_eq!(parse_duration_ms("2s", None).unwrap(), 2_000);
        assert_eq!(parse_duration_ms("3m", None).unwrap(), 180_000);
        assert_eq!(parse_duration_ms("1h", None).unwrap(), 3_600_000);
        assert_eq!(parse_duration_ms("100", None).unwrap(), 100);
        assert_eq!(parse_duration_ms("  30s  ", None).unwrap(), 30_000);
    }

    #[test]
    fn rejects_invalid_shapes() {
        for input in ["abc", "2d", "", "1.5s", "1H", "1 s", "+1s"] {
            assert!(parse_duration_ms(input, None).is_err(), "{input}");
        }
        assert_eq!(
            parse_duration_ms(" 2d ", None).unwrap_err().to_string(),
            "Invalid duration ' 2d '. Use ms, s, m, or h."
        );
    }

    #[test]
    fn rejects_values_beyond_javascript_safe_integer_range() {
        assert_eq!(
            parse_duration_ms("9007199254740991", None).unwrap(),
            MAX_SAFE_DURATION_MS
        );
        assert_eq!(
            parse_duration_ms("2501999792h", None).unwrap(),
            9_007_199_251_200_000
        );
        assert!(parse_duration_ms("9007199254740992", None).is_err());
        assert!(parse_duration_ms("2501999793h", None).is_err());
    }
}
