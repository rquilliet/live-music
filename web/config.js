/* Live in Paris — local configuration (no build step: edit this file).
   spotifyClientId: the client id of your Spotify app (developer.spotify.com), used by the "Mes artistes" pill
   (Authorization Code + PKCE, no secret). Empty = the pill explains that Spotify is not configured.
   feedback: where the Feedback button posts (REM-56). Nothing here is a secret: the page is public. Empty url = no button.
     url     the endpoint that receives the message
     fields  Google Form: the url is the form's ".../formResponse" and fields maps message / contact / context to the
             form's "entry.<id>" names (sent form-encoded, answer unreadable)
     extra   any other endpoint: sent as JSON {message, contact, context} plus these keys (e.g. a public access key) */
window.LIP_CONFIG = {
  spotifyClientId: "b0817d481aaf446996949f90b5c444da",
  feedback: { url: "", fields: null, extra: null },
};
