I need you to refactor the authentication module. Right now it's using a single middleware function that handles JWT validation, role checking, and rate limiting all in one place. The problem is that every time we add a new endpoint, we have to duplicate the permission logic.

Instead, I want you to split it into three separate middleware functions that can be composed together. Each one should handle a single responsibility and be
