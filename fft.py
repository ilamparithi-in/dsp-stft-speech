import numpy as np

def DFT(x):
    """
    The Discrete Fourier Transform is discrete both in the time and frequency
    domain. $$X(k) = \sum_{n=0}^{N-1}x[n]e^{-j\frac{2\pink}}{N}$$"""
    x = np.asarray(x, dtype=complex)
    N = x.shape[0]

    n = np.arange(N)
    k = n.reshape((N, 1))

    W = np.exp(-2j * np.pi * k * n / N) # kth row nth column
    X = W @ x
    return X


def FFT(x):
    """Decimation in Time, Radix 2, Recursive FFT
    Twiddle factor periodic over N, symmetric about N/2, N being r^anything (r = 2)
    W_N^k = -W_N^{k+N/2}
    W_N^k = W_N^{k+N}
    Input bit reversed - handled by recursion
    
    Cooley-Tukey Recursive FFT - O(NlogN) time complexity
    Divide and conquer - apply DFT recursively on odd and even halves of x
    Stride 1 chosen"""
    x = np.asarray(x, dtype=complex)
    N = x.shape[0]

    if N == 1: # Base case, 1 point DFT
        return x
    
    X_even = FFT(x[::2])
    X_odd  = FFT(x[1::2])

    twiddle = np.exp(-2j * np.pi * np.arange(N//2) / N)

    first_half  = X_even + twiddle[:N//2] * X_odd
    second_half = X_even - twiddle[N//2:] * X_odd

    return np.concatenate([first_half, second_half])

def FFT_safe(x):
    x = np.asarray(x, dtype=complex)
    N = x.shape[0]

    N_new = 1 << int(np.ceil(np.log2(N))) # 2^ceil(log2(N))
    if N_new != N: # radix-2 requirement, zero padding
        x = np.pad(x, (0, N_new - N))

    return FFT(x)

def smallest_factor(n):
    for i in range(2, int(np.sqrt(n)) + 1):
        if n % i == 0:
            return i
    return n

def FFT_mixed(x):
    """Mixed radix variant of the Cooley-Tukey FFT
    N = n1 * n2 -> n1 smaller n2-point DFTs"""
    x = np.asarray(x, dtype=complex)
    N = x.shape[0]
    if N == 1: # Base case, 1 point DFT
        return x

    r = smallest_factor(N)
    m = N // r
    x = x.reshape(r, m)

    k = np.arange(N).reshape(N, 1)
    n = np.arange(N).reshape(1, N)
    W = np.exp(-2j * np.pi * k * n / N)

    X = np.array([FFT_mixed(xi) for xi in x])

    X = X * np.exp(-2j * np.pi * (np.arange(r).reshape(-1,1) * np.arange(m)) / N)

    X = np.array([FFT_mixed(X[:, j]) for j in range(m)]).T

    X = X.reshape(N)
    return X

