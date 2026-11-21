# Fixtures

Entries of SANTA's vectors (`mwaddip/santa` at `ac93bd9`, under `vectors/`), at the path each has there. The runner's
unit tests read them, so `npm test` needs no SANTA checkout.

Twenty files are whole and byte-identical to SANTA's. Four hold the entries their test reads:

| File | Entries |
|---|---|
| `eval/v6/authored/Global.serialize_shared_nested.json` | `G-size-serialize-32768x512-a3#12` and `G-size-serialize-32768x2-a3#2` |
| `eval/v6/authored/Global.deserializeTo_Box_type_var_name_range.json` | the six `-just-` rows |
| `eval/v5/authored/Coll.declared_count_at_parse.json` | the 44 rows the JVM refuses |
| `eval/v6/authored/Coll.declared_count_at_parse_v6.json` | the 88 rows the JVM refuses |
