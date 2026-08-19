class BridgeError(Exception):
    def __init__(self, status: int, message: str, details: object = None):
        super().__init__(message)
        self.status = status
        self.message = message
        self.details = details

