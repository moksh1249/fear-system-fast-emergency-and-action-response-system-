#pragma once

// Minimal JSON DOM + parser (only what this project's map_data.json format
// needs: objects, arrays, strings with \u escapes, numbers, bool/null).
//
// Extracted from ch_preprocess.cpp so ch_query.cpp, backend/sim/sim_engine.cpp
// and any future C++ tool reading map_data.json share exactly one parser
// instead of each carrying its own copy - a plain move, no behaviour change
// (ch_preprocess.cpp used to define this inline; see its git history for the
// pre-extraction version if a diff is ever needed).

#include <charconv>
#include <cstdint>
#include <optional>
#include <sstream>
#include <stdexcept>
#include <string>
#include <string_view>
#include <utility>
#include <vector>

struct JsonValue {
    enum class Type { Null, Bool, Number, String, Array, Object };
    Type type = Type::Null;
    bool boolVal = false;
    double numVal = 0.0;
    std::string strVal;
    std::vector<JsonValue> arrVal;
    std::vector<std::pair<std::string, JsonValue>> objVal;

    const JsonValue* find(std::string_view key) const {
        for (auto& kv : objVal)
            if (kv.first == key) return &kv.second;
        return nullptr;
    }
    std::optional<std::string> str(std::string_view key) const {
        auto* v = find(key);
        if (v && v->type == Type::String) return v->strVal;
        return std::nullopt;
    }
    std::optional<double> num(std::string_view key) const {
        auto* v = find(key);
        if (v && v->type == Type::Number) return v->numVal;
        return std::nullopt;
    }
};

class JsonParser {
public:
    explicit JsonParser(const std::string& text) : s(text), n(text.size()) {}

    JsonValue parse() {
        skipWs();
        JsonValue v = parseValue();
        return v;
    }

private:
    const std::string& s;
    size_t n;
    size_t i = 0;

    [[noreturn]] void fail(const std::string& msg) {
        size_t line = 1, col = 1;
        for (size_t k = 0; k < i && k < n; ++k) {
            if (s[k] == '\n') { line++; col = 1; } else { col++; }
        }
        std::ostringstream oss;
        oss << "JSON parse error at line " << line << " col " << col << ": " << msg;
        throw std::runtime_error(oss.str());
    }

    void skipWs() {
        while (i < n && (s[i] == ' ' || s[i] == '\t' || s[i] == '\n' || s[i] == '\r')) ++i;
    }

    char peek() { return i < n ? s[i] : '\0'; }

    JsonValue parseValue() {
        skipWs();
        if (i >= n) fail("unexpected end of input");
        char c = s[i];
        if (c == '{') return parseObject();
        if (c == '[') return parseArray();
        if (c == '"') return parseString();
        if (c == 't' || c == 'f') return parseBool();
        if (c == 'n') return parseNull();
        if (c == '-' || (c >= '0' && c <= '9')) return parseNumber();
        fail(std::string("unexpected character '") + c + "'");
    }

    JsonValue parseObject() {
        JsonValue v;
        v.type = JsonValue::Type::Object;
        ++i;  // '{'
        skipWs();
        if (peek() == '}') { ++i; return v; }
        while (true) {
            skipWs();
            if (peek() != '"') fail("expected string key");
            JsonValue key = parseString();
            skipWs();
            if (peek() != ':') fail("expected ':'");
            ++i;
            JsonValue val = parseValue();
            v.objVal.emplace_back(std::move(key.strVal), std::move(val));
            skipWs();
            if (peek() == ',') { ++i; continue; }
            if (peek() == '}') { ++i; break; }
            fail("expected ',' or '}'");
        }
        return v;
    }

    JsonValue parseArray() {
        JsonValue v;
        v.type = JsonValue::Type::Array;
        ++i;  // '['
        skipWs();
        if (peek() == ']') { ++i; return v; }
        while (true) {
            JsonValue val = parseValue();
            v.arrVal.push_back(std::move(val));
            skipWs();
            if (peek() == ',') { ++i; continue; }
            if (peek() == ']') { ++i; break; }
            fail("expected ',' or ']'");
        }
        return v;
    }

    static void appendUtf8(std::string& out, uint32_t cp) {
        if (cp <= 0x7F) {
            out += static_cast<char>(cp);
        } else if (cp <= 0x7FF) {
            out += static_cast<char>(0xC0 | (cp >> 6));
            out += static_cast<char>(0x80 | (cp & 0x3F));
        } else if (cp <= 0xFFFF) {
            out += static_cast<char>(0xE0 | (cp >> 12));
            out += static_cast<char>(0x80 | ((cp >> 6) & 0x3F));
            out += static_cast<char>(0x80 | (cp & 0x3F));
        } else {
            out += static_cast<char>(0xF0 | (cp >> 18));
            out += static_cast<char>(0x80 | ((cp >> 12) & 0x3F));
            out += static_cast<char>(0x80 | ((cp >> 6) & 0x3F));
            out += static_cast<char>(0x80 | (cp & 0x3F));
        }
    }

    uint32_t parseHex4() {
        if (i + 4 > n) fail("truncated \\u escape");
        uint32_t v = 0;
        for (int k = 0; k < 4; ++k) {
            char c = s[i + k];
            v <<= 4;
            if (c >= '0' && c <= '9') v |= (c - '0');
            else if (c >= 'a' && c <= 'f') v |= (c - 'a' + 10);
            else if (c >= 'A' && c <= 'F') v |= (c - 'A' + 10);
            else fail("invalid \\u escape");
        }
        i += 4;
        return v;
    }

    JsonValue parseString() {
        JsonValue v;
        v.type = JsonValue::Type::String;
        ++i;  // opening quote
        std::string out;
        while (true) {
            if (i >= n) fail("unterminated string");
            char c = s[i++];
            if (c == '"') break;
            if (c == '\\') {
                if (i >= n) fail("unterminated escape");
                char e = s[i++];
                switch (e) {
                    case '"': out += '"'; break;
                    case '\\': out += '\\'; break;
                    case '/': out += '/'; break;
                    case 'b': out += '\b'; break;
                    case 'f': out += '\f'; break;
                    case 'n': out += '\n'; break;
                    case 'r': out += '\r'; break;
                    case 't': out += '\t'; break;
                    case 'u': {
                        uint32_t cp = parseHex4();
                        if (cp >= 0xD800 && cp <= 0xDBFF && i + 1 < n && s[i] == '\\' && s[i + 1] == 'u') {
                            size_t save = i;
                            i += 2;
                            uint32_t lo = parseHex4();
                            if (lo >= 0xDC00 && lo <= 0xDFFF) {
                                cp = 0x10000 + ((cp - 0xD800) << 10) + (lo - 0xDC00);
                            } else {
                                i = save;  // not a valid low surrogate, treat cp alone
                            }
                        }
                        appendUtf8(out, cp);
                        break;
                    }
                    default: fail("invalid escape character");
                }
            } else {
                out += c;
            }
        }
        v.strVal = std::move(out);
        return v;
    }

    JsonValue parseBool() {
        JsonValue v;
        v.type = JsonValue::Type::Bool;
        if (s.compare(i, 4, "true") == 0) { v.boolVal = true; i += 4; }
        else if (s.compare(i, 5, "false") == 0) { v.boolVal = false; i += 5; }
        else fail("invalid literal");
        return v;
    }

    JsonValue parseNull() {
        if (s.compare(i, 4, "null") != 0) fail("invalid literal");
        i += 4;
        JsonValue v;
        v.type = JsonValue::Type::Null;
        return v;
    }

    JsonValue parseNumber() {
        size_t start = i;
        if (peek() == '-') ++i;
        while (i < n && s[i] >= '0' && s[i] <= '9') ++i;
        if (i < n && s[i] == '.') {
            ++i;
            while (i < n && s[i] >= '0' && s[i] <= '9') ++i;
        }
        if (i < n && (s[i] == 'e' || s[i] == 'E')) {
            ++i;
            if (i < n && (s[i] == '+' || s[i] == '-')) ++i;
            while (i < n && s[i] >= '0' && s[i] <= '9') ++i;
        }
        JsonValue v;
        v.type = JsonValue::Type::Number;
        auto res = std::from_chars(s.data() + start, s.data() + i, v.numVal);
        if (res.ec != std::errc()) fail("invalid number");
        return v;
    }
};
