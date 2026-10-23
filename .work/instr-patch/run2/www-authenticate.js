// src/service/www-authenticate.ts
function escapeWWWAuthenticateValue(value) {
  return value.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
}
export {
  escapeWWWAuthenticateValue
};
